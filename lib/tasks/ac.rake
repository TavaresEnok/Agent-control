# frozen_string_literal: true

namespace :ac do
  desc "Import a legacy Paseo into Agent Control in read-only mode (RF-33, BUG-P2-04)"
  task :import_paseo, [:paseo_number, :project_id, :title] => :environment do |_t, args|
    paseo_number = args[:paseo_number] || ENV["PASEO_NUMBER"]
    project_id = args[:project_id] || ENV["PROJECT_ID"]
    title = args[:title] || ENV["TITLE"] || "Paseo #{paseo_number} Historic Import"

    if paseo_number.blank?
      puts "ERRO: paseo_number é obrigatório. Uso: bin/rails ac:import_paseo[number,project_id,title]"
      exit 1
    end

    project = if project_id.present?
                Project.find(project_id)
              else
                Project.first
              end

    unless project
      puts "ERRO: Nenhum projeto encontrado para associar o Paseo."
      exit 1
    end

    puts "Importando Paseo #{paseo_number} para o projeto #{project.name} (Company: #{project.company.name})..."

    result = AcPaseoImportService.import_paseo!(
      company: project.company,
      project: project,
      paseo_number: paseo_number,
      title: title,
      objective: "Importação histórica somente-leitura do Paseo #{paseo_number} (RF-33)",
      tasks_data: [
        {
          task_key: "task-hist-01",
          title: "Execução original do Paseo #{paseo_number}",
          scope: "Escopo original arquivado",
          state: :integrated
        }
      ],
      metadata: { source: "ac:import_paseo_rake", imported_at: Time.current.iso8601 }
    )

    if result.success?
      puts "SUCESSO: Paseo #{paseo_number} importado com sucesso!"
      puts "Context ID: #{result.work_context.id} (#{result.work_context.external_id})"
      puts "Plan ID: #{result.plan.id} (#{result.plan.plan_key})"
      puts "Tarefas arquivadas: #{result.tasks_count}"
    else
      puts "FALHA ao importar Paseo: #{result.error}"
      exit 1
    end
  end
end
