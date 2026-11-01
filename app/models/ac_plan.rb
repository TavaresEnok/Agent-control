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
  validate :new_plan_starts_as_draft, on: :create
  validate :published_contract_immutable, on: :update
  validate :publication_uses_validated_path, on: :update
  before_update :number_notification_transition
  after_update :record_notification_transition

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
    with_lock do
      next false unless draft? && published_at.nil?
      tasks = AcTask.where(ac_plan_id: id).order(:id).to_a
      problems = publication_errors(tasks)
      if problems.any?
        problems.each { |message| errors.add(:base, message) }
        next false
      end
      compute_content_hash!(tasks)
      begin
        @publishing = true
        update!(state: :active, published_at: Time.current, policy_revision: policy_revision)
      ensure
        @publishing = false
      end
    end
  end

  def published?
    published_at.present?
  end

  # ── Orquestração do DAG (§12.1, §12.2) ──────────────────────────────────
  def ready_tasks
    return [] unless active? && !paused? && ac_work_context.active?

    completed_keys = ac_tasks.where(state: "integrated").pluck(:task_key)

    ac_tasks.where(state: %w[pending queued needs_changes review approved]).select do |task|
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

    completed_keys = ac_tasks.where(state: "integrated").pluck(:task_key)
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

    ac_tasks.all? { |t| t.state.to_s == "integrated" }
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

  def number_notification_transition
    previous = metadata_in_database.is_a?(Hash) ? metadata_in_database : {}
    existing = previous["notification_transition_counter"]
    next_counter = (notification_transition_pending?) ? existing.to_i + 1 : existing
    return if (metadata || {})["notification_transition_counter"] == next_counter

    self.metadata = (metadata || {}).merge("notification_transition_counter" => next_counter)
  end

  def notification_transition_pending?
    old_metadata = metadata_in_database.is_a?(Hash) ? metadata_in_database : {}
    pause_started = metadata.is_a?(Hash) && metadata["paused"] == true && old_metadata["paused"] != true
    pause_started || (will_save_change_to_state? && state.to_s == "abandoned")
  end

  def record_notification_transition
    old_metadata, new_metadata = saved_change_to_metadata || [ nil, nil ]
    pause_started = new_metadata.is_a?(Hash) && new_metadata["paused"] == true && (!old_metadata.is_a?(Hash) || old_metadata["paused"] != true)
    cancelled = saved_change_to_state? && state.to_s == "abandoned"
    return unless pause_started || cancelled

    AcNotificationService.record_operational!(record: self, kind: cancelled ? "plan_cancelled" : "plan_paused",
      transition: metadata.fetch("notification_transition_counter"))
  end

  def new_plan_starts_as_draft
    return if state.to_s == "draft" && published_at.nil?

    errors.add(:state, "planos novos devem começar em rascunho")
  end

  def publication_uses_validated_path
    return unless published_at_was.nil? && published_at.present? && !@publishing

    errors.add(:published_at, "deve ser publicado pelo fluxo de validação")
  end

  def publication_errors(tasks)
    problems = []
    unless tasks.all? { |task| task.company_id == company_id && task.project_id == project_id }
      problems << "Tarefas devem pertencer à mesma empresa e projeto do plano"
    end
    keys = tasks.map(&:task_key)
    dependencies = tasks.to_h { |task| [ task.task_key, Array(task.depends_on).dup ] }
    unless keys.uniq.size == keys.size && dependencies.values.flatten.all? { |key| keys.include?(key) }
      problems << "Dependências devem referenciar tarefas do plano"
      return problems
    end
    until dependencies.empty?
      ready = dependencies.select { |_key, deps| deps.empty? }.keys
      if ready.empty?
        problems << "Dependências do plano contêm ciclo"
        break
      end
      ready.each { |key| dependencies.delete(key) }
      dependencies.each_value { |deps| deps.reject! { |key| ready.include?(key) } }
    end
    problems
  end

  def published_contract_immutable
    return unless published_at_was.present?
    return if (changes.keys & %w[plan_key version title objective project_id company_id ac_work_context_id policy_revision_id content_hash published_at]).empty?

    errors.add(:base, "Contrato publicado é imutável; crie nova versão")
  end

  def content_hash_required_when_active
    return unless active?
    return if content_hash.present?

    errors.add(:content_hash, "é obrigatório para planos ativos")
  end

  def compute_content_hash!(tasks)
    data = {
      plan_key: plan_key,
      version: version,
      title: title,
      objective: objective,
      tasks: tasks.sort_by(&:task_key).map do |task|
        task.slice(:task_key, :title, :scope, :inputs, :outputs, :depends_on, :risk_class, :assigned_role)
          .merge("metadata" => (task.metadata || {}).deep_stringify_keys.slice(*AcTask::CONTRACT_METADATA_KEYS))
      end
    }.to_json
    self.content_hash = Digest::SHA256.hexdigest(data)
  end
end
