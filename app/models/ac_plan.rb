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
