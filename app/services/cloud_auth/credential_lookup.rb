# frozen_string_literal: true

module CloudAuth
  # Which claude_code credential a cloud connection lives on.
  #
  # Credentials are per (user, company) — the same person connects a separate AWS
  # account per company so Bedrock spend lands on the company that incurred it. So
  # there is no such thing as "the user's cloud connection": every read here names a
  # company, and for a session that company comes from SessionCompany, never from a
  # web session or a first-membership guess.
  module CredentialLookup
    AGENT_TYPE = "claude_code"

    module_function

    # nil when the company cannot be named — a caller with no company has no
    # connection to read, which is not the same as a broken one.
    def claude_code(user_id:, company_id:)
      return nil if user_id.blank? || company_id.blank?

      credentials = AgentCredential.where(user_id: user_id, company_id: company_id, agent_type: AGENT_TYPE).limit(2).to_a
      credentials.one? ? credentials.first : nil
    end

    def for_session(session)
      return nil if session.nil?

      SessionCompany.credential_for(session, agent_type: AGENT_TYPE)
    end
  end
end
