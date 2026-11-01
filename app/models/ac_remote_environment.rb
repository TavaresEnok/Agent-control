# frozen_string_literal: true

class AcRemoteEnvironment < ApplicationRecord
  STATES = %w[active paused disabled].freeze

  belongs_to :company
  belongs_to :project
  has_many :ac_remote_operations, dependent: :restrict_with_error

  validates :name, presence: true
  validates :environment_slug,
            presence: true,
            uniqueness: { scope: :company_id },
            format: { with: /\A[a-z0-9_-]+\z/, message: "deve conter apenas letras minúsculas, números, hífens ou sublinhados" }
  validates :host, presence: true, format: { with: /\A[a-zA-Z0-9][a-zA-Z0-9.-]*\z/ }
  validates :port, numericality: { only_integer: true, in: 1..65535 }
  validates :user, presence: true, format: { with: /\A[a-z_][a-z0-9_-]*\z/ }
  validates :fingerprint, presence: true
  validates :identity_key_path, presence: true
  validates :known_hosts_path, presence: true
  validates :state, inclusion: { in: STATES }

  validate :validate_authorized_directories

  def active?
    state == "active"
  end

  def directory_authorized?(dir_path)
    return false if dir_path.to_s.strip.empty?

    clean_dir = File.expand_path(dir_path.to_s.strip)
    authorized_directories.any? do |auth_dir|
      clean_auth = File.expand_path(auth_dir.to_s.strip)
      clean_dir == clean_auth || clean_dir.start_with?(clean_auth.end_with?("/") ? clean_auth : "#{clean_auth}/")
    end
  end

  def build_transport(lab_opt_in: true)
    AgentControl::OpenSshTransport.new(
      host: host,
      user: user,
      port: port,
      identity_file: identity_key_path,
      known_hosts_file: known_hosts_path,
      fingerprint: fingerprint,
      lab_opt_in: lab_opt_in
    )
  end

  private

  def validate_authorized_directories
    unless authorized_directories.is_a?(Array) && authorized_directories.any?
      errors.add(:authorized_directories, "deve ser uma lista contendo ao menos um diretório autorizado")
      return
    end

    authorized_directories.each do |dir|
      if dir.to_s.blank? || !dir.to_s.start_with?("/")
        errors.add(:authorized_directories, "todos os diretórios devem ser caminhos absolutos válidos")
        break
      end
    end
  end
end
