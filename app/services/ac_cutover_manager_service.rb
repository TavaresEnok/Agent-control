# frozen_string_literal: true

class AcCutoverManagerService
  class CutoverError < StandardError; end
  class UnauthorizedCutoverError < CutoverError; end
  class ProjectNotMigratedError < CutoverError; end
  class AuthorityUnavailableError < CutoverError; end

  class << self
    def execute_cutover!(project:, approved_by:, cutoff_ticket: nil, redirect_links: {})
      raise ArgumentError, "project é obrigatório" if project.blank?

      authorized_user!(project, approved_by)
      AcMigrationService.verify_migration_integrity!(project: project)
      raise AuthorityUnavailableError, "Cutover requer adaptador externo e recibo verificável de autoridade e bloqueio legado"
    end

    def cutover_status(project:)
      raise ArgumentError, "project é obrigatório" if project.blank?

      # Stored settings are not proof that a remote authority was transferred.
      { project_id: project.id, cutover_completed: false, authority_mode: "unverified" }
    end

    def revert_cutover!(project:, reason:, reverted_by:)
      raise ArgumentError, "project é obrigatório" if project.blank?
      raise ArgumentError, "reason é obrigatório" if reason.to_s.strip.empty?

      authorized_user!(project, reverted_by)
      raise AuthorityUnavailableError, "Reversão requer adaptador externo e recibo verificável de autoridade"
    end

    private

    def authorized_user!(project, identifier)
      scope = User.authenticatable
      user = if identifier.is_a?(User)
        scope.find_by(id: identifier.id)
      elsif identifier.to_s.match?(/\A\d+\z/)
        scope.find_by(id: identifier.to_s)
      else
        scope.find_by(email: identifier.to_s)
      end
      membership = user && CompanyMembership.active.find_by(user_id: user.id, company_id: project.company_id)
      unless membership && (membership.admin? || project.owner_id == user.id) && project.accessible_by?(user)
        raise UnauthorizedCutoverError, "Aprovador não autorizado para este projeto"
      end

      user
    end
  end
end
