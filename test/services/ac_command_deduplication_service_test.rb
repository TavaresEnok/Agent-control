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

    refute res1[:deduplicated]
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

    assert res2[:deduplicated], "Deve marcar como deduplicado"
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

  test "failure rolls back both local effects and the command" do
    assert_raises(RuntimeError) do
      AcCommandDeduplicationService.execute_idempotent!(intent_id: "failed", company: @company,
        command_type: "create", user: @user) do
        @company.update!(name: "Temporary")
        raise "failure"
      end
    end
    assert_not_equal "Temporary", @company.reload.name
    assert_not AcClientCommand.exists?(company: @company, intent_id: "failed")
  end

  test "intent is scoped by company and rejects changed author or payload" do
    other = create(:company)
    AcCommandDeduplicationService.execute_idempotent!(intent_id: "same", company: @company,
      command_type: "create", payload: { title: "one" }, user: @user) { { id: 1 } }
    result = AcCommandDeduplicationService.execute_idempotent!(intent_id: "same", company: other,
      command_type: "create", payload: { title: "one" }, user: @user) { { id: 2 } }
    assert_equal 2, result[:result]["id"]
    assert_raises(AcCommandDeduplicationService::IntentMismatchError) do
      AcCommandDeduplicationService.execute_idempotent!(intent_id: "same", company: @company,
        command_type: "create", payload: { title: "two" }, user: @user) { flunk }
    end
    assert_raises(AcCommandDeduplicationService::IntentMismatchError) do
      AcCommandDeduplicationService.execute_idempotent!(intent_id: "same", company: @company,
        command_type: "create", payload: { title: "one" }, user: nil) { flunk }
    end
  end
end
