# frozen_string_literal: true

# AcCutoverManagerService — Acompanhamento de Cutover e Atualização de Rastreabilidade (Gate G7, §17.4, §19.2 F7)
#
# Critério Gate G7: Substituição autorizada, sem perda de entregas/histórico e com responsáveis claros.
#
# Responsabilidades:
# 1. Execução formal do Cutover com autorização explícita registrada;
# 2. Atualização e redirecionamento de links de rastreabilidade (dashboards, webhooks, integrações);
# 3. Consulta de status e relatório de substituição para auditoria;
# 4. Mecanismo seguro de reversão para rollback de emergência se necessário.
class AcCutoverManagerService
  class CutoverError < StandardError; end
  class UnauthorizedCutoverError < CutoverError; end
  class ProjectNotMigratedError < CutoverError; end

  class << self
    def execute_cutover!(project:, approved_by:, cutoff_ticket: nil, redirect_links: {})
      raise ArgumentError, "project é obrigatório" if project.blank?
      if approved_by.to_s.strip.empty?
        raise UnauthorizedCutoverError, "Cutover exige autorização explícita com identificador do aprovador (Gate G7)"
      end

      # 1. Verifica se a migração prévia de autoridade foi realizada
      authority_mode = project.settings&.dig("authority_mode")
      unless authority_mode == "agent_control_exclusive"
        raise ProjectNotMigratedError, "Projeto deve ter autoridade exclusiva migrada antes do cutover final"
      end

      # 2. Registra o cutover e atualiza os links de rastreabilidade
      project.settings ||= {}
      project.settings["cutover_status"] = "completed"
      project.settings["cutover_approved_by"] = approved_by
      project.settings["cutoff_ticket"] = cutoff_ticket || "CUTOVER-#{project.id}-#{Time.current.to_i}"
      project.settings["redirect_links"] = (redirect_links || {}).to_h
      project.settings["cutover_at"] = Time.current.iso8601

      project.save!

      # 3. Emite evento de auditoria se o modelo estiver disponível
      if defined?(AcDecisionAuditEvent)
        AcDecisionAuditEvent.record_decision!(
          context_or_project: project,
          decision_type: "cutover_completed",
          actor: approved_by,
          metadata: {
            cutoff_ticket: project.settings["cutoff_ticket"],
            redirect_links: project.settings["redirect_links"],
            authority_mode: authority_mode
          }
        ) rescue nil
      end

      # 4. Retorna ata formal de cutover (evidência do Gate G7)
      {
        project_id: project.id,
        status: "cutover_completed",
        approved_by: approved_by,
        cutoff_ticket: project.settings["cutoff_ticket"],
        redirect_links: project.settings["redirect_links"],
        cutover_at: project.settings["cutover_at"],
        authority_mode: authority_mode
      }
    end

    def cutover_status(project:)
      raise ArgumentError, "project é obrigatório" if project.blank?

      settings = project.settings || {}
      {
        project_id: project.id,
        cutover_completed: settings["cutover_status"] == "completed",
        approved_by: settings["cutover_approved_by"],
        cutoff_ticket: settings["cutoff_ticket"],
        redirect_links: settings["redirect_links"] || {},
        cutover_at: settings["cutover_at"],
        authority_mode: settings["authority_mode"] || "legacy"
      }
    end

    def revert_cutover!(project:, reason:, reverted_by:)
      raise ArgumentError, "project é obrigatório" if project.blank?
      raise ArgumentError, "reason e reverted_by são obrigatórios" if reason.to_s.strip.empty? || reverted_by.to_s.strip.empty?

      project.settings ||= {}
      project.settings["cutover_status"] = "reverted"
      project.settings["cutover_reverted_at"] = Time.current.iso8601
      project.settings["cutover_reverted_by"] = reverted_by
      project.settings["cutover_revert_reason"] = reason
      project.settings["authority_mode"] = "coexistence_read_only"

      project.save!

      {
        project_id: project.id,
        status: "cutover_reverted",
        reverted_at: project.settings["cutover_reverted_at"],
        reverted_by: reverted_by,
        reason: reason
      }
    end
  end
end
