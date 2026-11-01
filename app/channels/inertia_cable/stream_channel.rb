# frozen_string_literal: true

module InertiaCable
  class StreamChannel < ActionCable::Channel::Base
    def subscribed
      verified_stream = InertiaCable.signed_stream_verifier.verified(params[:signed_stream_name])
      if verified_stream && authorized_stream?(verified_stream)
        stream_from Array(verified_stream).join(":")
      else
        reject
      end
    end

    private

    def authorized_stream?(stream)
      return false unless current_user

      stream_str = Array(stream).join(":")
      parts = stream_str.split(":")

      entities = parts.filter_map do |part|
        gid = GlobalID.parse(part)
        GlobalID::Locator.locate(gid) if gid
      rescue StandardError
        nil
      end

      return false if entities.empty?

      entities.all? { |entity| authorize_entity(entity) }
    end

    def authorize_entity(entity)
      case entity
      when Company
        current_user.company_memberships.active.exists?(company_id: entity.id)
      when Project, TerminalSession
        current_user.company_memberships.active.exists?(company_id: entity.company_id)
      when WorkflowRun
        current_user.company_memberships.active.exists?(company_id: entity.project&.company_id)
      when User
        current_user.id == entity.id ||
          current_user.company_memberships.active.where(company_id: entity.company_memberships.active.select(:company_id)).exists?
      else
        if entity.respond_to?(:company_id)
          current_user.company_memberships.active.exists?(company_id: entity.company_id)
        else
          true
        end
      end
    end
  end
end
