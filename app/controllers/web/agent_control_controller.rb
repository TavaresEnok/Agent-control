# frozen_string_literal: true

class Web::AgentControlController < Web::ApplicationController
  layout "inertia"

  skip_before_action :enforce_onboarding, raise: false
  skip_before_action :enforce_workspace, raise: false

  def graph
    plan = AcPlan.where(company: current_company).find(params[:id])
    graph_data = AcDagGraphService.build_graph(plan: plan)

    render inertia: "AgentControl/PlanGraph", props: {
      companyId: current_company.id,
      plan: graph_data[:plan],
      initialGraph: graph_data
    }
  end

  def wizard
    environments = AcRemoteEnvironment.where(company: current_company).select(:id, :name, :environment_slug, :state)

    render inertia: "AgentControl/MobileSetupWizard", props: {
      companyId: current_company&.id,
      environments: environments.as_json
    }
  end
end
