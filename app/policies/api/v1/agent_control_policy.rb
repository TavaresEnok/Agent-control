# frozen_string_literal: true

module Api
  module V1
    class AgentControlPolicy < ApplicationPolicy
      def show?
        membership.present?
      end

      def create?
        membership.present? && !membership.viewer?
      end
    end
  end
end
