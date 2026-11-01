# frozen_string_literal: true

# Which company a TerminalSession acts for, and the membership that carries that
# company's onboarding answers and agent credential.
#
# There is no web session here — Temporal activities, container strategies and
# workflow runs all reach this code with no cookie — so the company is NEVER
# taken from `session[:current_company_id]`. It is terminal_sessions.company_id,
# which every session carries (the project's company for project-bound ones);
# the project is consulted only for a record that has not been validated yet.
#
# Nothing falls back to "the user's first membership": for a multi-company user
# that is a coin flip, and the thing being chosen is who gets billed.
class SessionCompany
  class << self
    def company_id_for(session)
      return nil unless session

      session.company_id || session.project&.company_id
    end

    def company_for(session)
      return session.company if session&.company_id

      session&.project&.company
    end

    # The acting member's membership in the session's company — the source of
    # per-company agent credentials, the default runtime and the agent language.
    # nil when the company cannot be resolved or the user is no longer a member.
    def membership_for(session)
      company_id = company_id_for(session)
      return nil if company_id.blank? || session.user_id.blank?

      CompanyMembership.find_by(user_id: session.user_id, company_id: company_id)
    end

    # An explicit identity is authoritative, even when invalid. Legacy sessions may
    # infer an identity only when exactly one credential of that type exists.
    def credential_for(session, agent_type: nil)
      return nil unless session

      type = agent_type || session.agent_type
      return nil if type.blank? || session.agent_type.to_s != type.to_s

      scope = agent_credentials_for(session).where(agent_type: type)
      config = session.session_config || {}
      if config.key?("agent_credential_id")
        return scope.find_by(id: config["agent_credential_id"]) if config["agent_credential_id"].present?

        return nil
      end

      candidates = scope.limit(2).to_a
      candidates.one? ? candidates.first : nil
    end

    # Credentials usable by this session, scoped to its company.
    def agent_credentials_for(session)
      company_id = company_id_for(session)
      return AgentCredential.none if company_id.blank? || session.user_id.blank?

      AgentCredential.where(user_id: session.user_id, company_id: company_id)
    end
  end
end
