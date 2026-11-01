# frozen_string_literal: true

# AcPlan — Plano versionado com dependências e critérios de aceite (RF-15)
#
# Planos são imutáveis após publicação: revisão cria nova versão (RF-42).
# A identidade de um thread de planos é o plan_key; a versão sequencial
# distingue revisões do mesmo objetivo.
#
# Plano Mestre §6 (Plano), §11.2 (TaskContract)
class AcPlan < ApplicationRecord
  extend Enumerize

  # Locatário
  belongs_to :company
  belongs_to :project

  # Contexto ao qual o plano pertence
  belongs_to :ac_work_context

  # Criador humano opcional
  belongs_to :created_by_user, class_name: "User", optional: true,
             foreign_key: :created_by_user_id

  # Política vigente na publicação
  belongs_to :policy_revision, class_name: "AcPolicyRevision",
             foreign_key: :policy_revision_id, optional: true

  # Tarefas do plano
  has_many :ac_tasks, foreign_key: :ac_plan_id, dependent: :destroy, inverse_of: :ac_plan

  enumerize :state, in: %i[draft active completed abandoned superseded],
            default: :draft, predicates: true, scope: true

  enumerize :created_by_type, in: %i[human manager_agent import],
            default: :human, predicates: true

  # ── Validações ──────────────────────────────────────────────────────────
  validates :plan_key, presence: true,
            format: { with: /\A[a-z0-9_\-]+\z/i }
  validates :version, presence: true, numericality: { greater_than: 0, only_integer: true }
  validates :title, presence: true, length: { maximum: 255 }
  validates :state, presence: true

  # Plano publicado deve ter hash de conteúdo
  validate :content_hash_required_when_active

  # Unicidade: plan_key + version dentro da company
  validates :version, uniqueness: { scope: :plan_key,
            message: "já existe para este plan_key" }

  # ── Escopos ─────────────────────────────────────────────────────────────
  scope :for_context, ->(ctx) { where(ac_work_context: ctx) }
  scope :published, -> { where.not(published_at: nil) }
  scope :latest_per_key, -> {
    where(id: select("DISTINCT ON (plan_key) id").order("plan_key, version DESC"))
  }

  # ── Publicação ───────────────────────────────────────────────────────────
  # Após publish!, o plano torna-se imutável (RF-42)
  def publish!(policy_revision: nil)
    return false if published_at.present?

    compute_content_hash!
    update!(
      state: :active,
      published_at: Time.current,
      policy_revision: policy_revision
    )
  end

  def published?
    published_at.present?
  end

  # ── Orquestração do DAG (§12.1, §12.2) ──────────────────────────────────
  def ready_tasks
    completed_keys = ac_tasks.where(state: %w[integrated approved completed]).pluck(:task_key)

    ac_tasks.where(state: %w[pending needs_changes]).select do |task|
      (task.depends_on || []).all? { |dep_key| completed_keys.include?(dep_key) }
    end
  end

  # ── Controles de Ciclo de Vida (§12, RF-24, RF-44) ──────────────────────
  def paused?
    metadata&.dig("paused") == true
  end

  def pause!(reason: nil, user: nil)
    update!(
      metadata: (metadata || {}).merge(
        "paused" => true,
        "paused_at" => Time.current.iso8601,
        "pause_reason" => reason
      )
    )

    if user
      AcDecisionAuditEvent.record_human_intervention!(
        company: company,
        project: project,
        user: user,
        action: "pause_plan",
        reason: reason || "Pausa operacional solicitada pelo operador",
        metadata: { plan_id: id, plan_key: plan_key }
      )
    end
    true
  end

  def resume!(user: nil)
    update!(
      metadata: (metadata || {}).merge(
        "paused" => false,
        "resumed_at" => Time.current.iso8601
      )
    )

    if user
      AcDecisionAuditEvent.record_human_intervention!(
        company: company,
        project: project,
        user: user,
        action: "resume_plan",
        reason: "Retomada operacional solicitada pelo operador",
        metadata: { plan_id: id, plan_key: plan_key }
      )
    end
    true
  end

  def cancel!(reason: nil, user: nil)
    update!(
      state: :abandoned,
      metadata: (metadata || {}).merge(
        "cancelled" => true,
        "cancelled_at" => Time.current.iso8601,
        "cancellation_reason" => reason
      )
    )

    # Cancela tarefas não terminais
    ac_tasks.where.not(state: %w[integrated failed cancelled]).update_all(state: "cancelled")

    if user
      AcDecisionAuditEvent.record_human_intervention!(
        company: company,
        project: project,
        user: user,
        action: "cancel_plan",
        reason: reason || "Cancelamento operacional solicitado pelo operador",
        metadata: { plan_id: id, plan_key: plan_key }
      )
    end
    true
  end

  # Avalia e avança os estados das tarefas conforme suas dependências
  def advance_dag!
    return [] if paused? || abandoned?

    completed_keys = ac_tasks.where(state: %w[integrated approved completed]).pluck(:task_key)
    newly_ready = []

    ac_tasks.each do |task|
      next if %w[running review approved integrated failed cancelled].include?(task.state.to_s)

      deps = task.depends_on || []
      deps_satisfied = deps.all? { |k| completed_keys.include?(k) }

      if deps_satisfied
        if task.state == "waiting_dependencies"
          task.update!(state: :pending)
          newly_ready << task
        elsif %w[pending needs_changes].include?(task.state.to_s)
          newly_ready << task
        end
      else
        if task.state == "pending"
          task.update!(state: :waiting_dependencies)
        end
      end
    end

    newly_ready
  end

  def all_tasks_completed?
    return false if ac_tasks.empty?

    ac_tasks.all? { |t| %w[integrated approved completed].include?(t.state.to_s) }
  end

  # Criar nova versão a partir deste plano
  def new_version
    self.class.new(
      company: company,
      project: project,
      ac_work_context: ac_work_context,
      plan_key: plan_key,
      version: version + 1,
      title: title,
      objective: objective,
      created_by_type: created_by_type
    )
  end

  private

  def content_hash_required_when_active
    return unless active?
    return if content_hash.present?

    errors.add(:content_hash, "é obrigatório para planos ativos")
  end

  def compute_content_hash!
    data = {
      plan_key: plan_key,
      version: version,
      title: title,
      objective: objective,
      tasks: ac_tasks.order(:task_key).map { |t| t.slice(:task_key, :title, :scope, :inputs, :outputs) }
    }.to_json
    self.content_hash = Digest::SHA256.hexdigest(data)
  end
end
