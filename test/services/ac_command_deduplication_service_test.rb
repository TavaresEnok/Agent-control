# frozen_string_literal: true

require "test_helper"

class AcCommandDeduplicationServiceTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
  end

  # Prova G5-E1: Deduplicação rigorosa de comandos móveis repetidos com mesmo intent_id (RF-53, §11.2)
  test "G5-E1: strict deduplication skips block execution on repeated intent_id" do
    intent_id = "intent-idemp-#{SecureRandom.hex(6)}"
    execution_counter = 0

    # 1. Primeiro envio do comando pelo cliente
    res1 = AcCommandDeduplicationService.execute_idempotent!(
      intent_id: intent_id,
      company: @company,
      command_type: "create_task",
      payload: { "title" => "Tarefa Original" },
      user: @user
    ) do
      execution_counter += 1
      { "task_id" => 42, "status" => "created" }
    end

    assert_equal false, res1[:deduplicated]
    assert_equal "processed", res1[:status]
    assert_equal 42, res1[:result]["task_id"]
    assert_equal 1, execution_counter

    # 2. Segundo envio com o mesmo intent_id (ex: retry móvel, reconexão de rede ou duplo clique)
    res2 = AcCommandDeduplicationService.execute_idempotent!(
      intent_id: intent_id,
      company: @company,
      command_type: "create_task",
      payload: { "title" => "Tarefa Original" },
      user: @user
    ) do
      execution_counter += 1
      { "task_id" => 999, "status" => "should_not_run" }
    end

    assert_equal true, res2[:deduplicated], "Deve marcar como deduplicado"
    assert_equal "processed", res2[:status]
    assert_equal 42, res2[:result]["task_id"], "Deve retornar o resultado do primeiro processamento"
    assert_equal 1, execution_counter, "O bloco de lógica NÃO deve ser executado novamente"
  end

  test "concurrent processing attempt with same intent_id raises DuplicateProcessingError" do
    intent_id = "intent-concurrent-#{SecureRandom.hex(6)}"

    # Pré-cria comando em estado 'processing'
    AcClientCommand.create!(
      company: @company,
      user: @user,
      intent_id: intent_id,
      command_type: "test_cmd",
      state: "processing"
    )

    assert_raises(AcCommandDeduplicationService::DuplicateProcessingError) do
      AcCommandDeduplicationService.execute_idempotent!(
        intent_id: intent_id,
        company: @company,
        command_type: "test_cmd",
        user: @user
      ) { { "ok" => true } }
    end
  end

  test "exception in block records failure and propagates exception" do
    intent_id = "intent-fail-#{SecureRandom.hex(6)}"

    assert_raises(RuntimeError) do
      AcCommandDeduplicationService.execute_idempotent!(
        intent_id: intent_id,
        company: @company,
        command_type: "failing_cmd",
        user: @user
      ) do
        raise "Erro deliberado de execução"
      end
    end

    cmd = AcClientCommand.find_by!(intent_id: intent_id)
    assert_equal "failed", cmd.state
    assert_equal "Erro deliberado de execução", cmd.error_message
  end
end
