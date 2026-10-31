# frozen_string_literal: true

# AcPolicyRevision — Documento de política validado e imutável (§6, §11.2)
#
# Após publicação, o conteúdo não pode ser alterado.
# Mudanças criam nova revisão com referência à antecessora.
#
# RF-08: Validar catálogo e combinações antes de publicar
# RF-09: Exibir versão aplicada e explicar decisão
# RF-42: Edição concorrente validada; reversão para versão anterior disponível
class AcPolicyRevision < ApplicationRecord
  extend Enumerize

  # Locatário
  belongs_to :company

  # Cadeia de revisões
  belongs_to :predecessor, class_name: "AcPolicyRevision",
             foreign_key: :predecessor_id, optional: true

  has_many :successors, class_name: "AcPolicyRevision",
           foreign_key: :predecessor_id, dependent: :nullify

  # Perfis definidos nesta revisão
  has_many :ac_execution_profiles, foreign_key: :ac_policy_revision_id,
           dependent: :destroy, inverse_of: :ac_policy_revision

  # Publicado por
  belongs_to :published_by_user, class_name: "User",
             foreign_key: :published_by_user_id, optional: true

  # Revogado por
  belongs_to :revoked_by_user, class_name: "User",
             foreign_key: :revoked_by_user_id, optional: true

  # Eventos de auditoria
  has_many :ac_decision_audit_events, foreign_key: :ac_policy_revision_id,
           dependent: :nullify, inverse_of: false

  enumerize :state, in: %i[draft published superseded revoked],
            default: :draft, predicates: true, scope: true

  enumerize :apply_mode, in: %i[next_attempts drain_and_switch immediate_revoke],
            default: :next_attempts, predicates: true

  # Validadores do conteúdo da política (RF-08)
  REQUIRED_CONTENT_KEYS = %w[model_chain effort_limits active_accounts chain_rules].freeze
  BLOCKED_MODELS = %w[astra ultra xhigh].freeze
  MAX_ALLOWED_EFFORT = "high"

  # ── Validações ──────────────────────────────────────────────────────────
  validates :revision_number, presence: true, numericality: { greater_than: 0, only_integer: true }
  validates :revision_number, uniqueness: { scope: :company_id }
  validates :content_hash, presence: true, uniqueness: true
  validates :content, presence: true
  validate :validation_result_is_hash
  validates :state, presence: true
  validates :apply_mode, presence: true

  validate :content_structure_valid, if: -> { new_record? || will_save_change_to_content? }
  validate :immutable_when_published, on: :update

  # ── Escopos ─────────────────────────────────────────────────────────────
  scope :for_company, ->(company) { where(company: company) }
  scope :current, -> { where(state: :published).order(revision_number: :desc).limit(1) }

  # ── Publicação ───────────────────────────────────────────────────────────
  def publish!(by_user:)
    return false unless draft?

    errors_found = validate_content_for_publication
    if errors_found.any?
      update!(validation_result: { errors: errors_found, valid: false })
      return false
    end

    supersede_current_published!

    update!(
      state: :published,
      published_at: Time.current,
      published_by_user: by_user,
      validation_result: { valid: true, errors: [] }
    )
    true
  end

  # Revogação de emergência (immediate_revoke — §11.4)
  def revoke!(by_user:, reason:)
    return false if revoked?

    update!(
      state: :revoked,
      revoked_at: Time.current,
      revoked_by_user: by_user,
      revoked_reason: reason
    )
  end

  # Cria nova revisão a partir desta (RF-42)
  def create_successor(content:, apply_mode: :next_attempts)
    hash = Digest::SHA256.hexdigest(content.to_json)
    max_rev = AcPolicyRevision.where(company_id: company_id).maximum(:revision_number).to_i
    self.class.new(
      company: company,
      predecessor: self,
      revision_number: max_rev + 1,
      content: content,
      content_hash: hash,
      diff: compute_diff(content),
      apply_mode: apply_mode,
      validation_result: {}
    )
  end

  def validation_result_is_hash
    errors.add(:validation_result, "deve ser um Hash") unless validation_result.is_a?(Hash)
  end

  def content_structure_valid
    return if content.blank?

    REQUIRED_CONTENT_KEYS.each do |key|
      unless content.key?(key)
        errors.add(:content, "deve conter a chave '#{key}' (RF-08)")
      end
    end

    # Bloquear modelos proibidos (ADR-002, §9.1)
    all_models = []
    (content["model_chain"] || []).each do |entry|
      if entry.is_a?(Hash)
        all_models << entry["model_id"]
        all_models << entry["effort"]
      else
        all_models << entry.to_s
      end
    end
    (content["active_accounts"] || []).each do |acc|
      if acc.is_a?(Hash)
        all_models << acc["model_id"]
        all_models << acc["effort"]
      else
        all_models << acc.to_s
      end
    end
    if content["effort_limits"].is_a?(Hash)
      all_models.concat(content["effort_limits"].values.map(&:to_s))
    end
    all_models.compact!

    BLOCKED_MODELS.each do |blocked|
      if all_models.any? { |m| m.to_s.downcase.include?(blocked) }
        errors.add(:content, "contém modelo/esforço bloqueado '#{blocked}' (ADR-002)")
      end
    end
  end

  def immutable_when_published
    return unless %w[published superseded revoked].include?(state_was.to_s)
    return if (changes.keys - %w[state revoked_at revoked_reason revoked_by_user_id updated_at]).empty?

    errors.add(:base, "Política publicada é imutável (RF-42). Crie uma nova revisão.")
  end

  def only_state_changing?
    (saved_changes.keys - %w[state revoked_at revoked_reason revoked_by_user_id updated_at]).empty?
  end

  def supersede_current_published!
    AcPolicyRevision.where(company_id: company_id, state: :published).update_all(state: :superseded)
  end

  def validate_content_for_publication
    errs = []
    REQUIRED_CONTENT_KEYS.each do |key|
      errs << "Chave obrigatória '#{key}' ausente" unless content.key?(key)
    end
    errs
  end

  def compute_diff(new_content)
    old_content = content || {}
    {
      added: (new_content.keys - old_content.keys),
      removed: (old_content.keys - new_content.keys),
      changed: new_content.keys.select { |k| new_content[k] != old_content[k] }
    }
  end
end
