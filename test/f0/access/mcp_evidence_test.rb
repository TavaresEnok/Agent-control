# frozen_string_literal: true

require "minitest/autorun"
require_relative "../../../tools/f0/access/mcp_evidence"

class MCPEvidenceTest < Minitest::Test
  Response = Struct.new(:code, :body)
  E = F0Access::MCPEvidence

  def response(payload, status: "200")
    Response.new(status, JSON.generate({ "jsonrpc" => "2.0", "id" => 1 }.merge(payload)))
  end

  def tool_error(text)
    response({ "result" => { "isError" => true, "content" => [{ "type" => "text", "text" => text }] } })
  end

  def test_exact_policy_and_lookup_denials
    assert E.classify(tool_error("Not allowed to create this resource"), expected: "create_policy_denied").first
    assert E.classify(tool_error("Project 42 not found"), expected: "project_lookup_denied", project_id: 42).first
    refute E.classify(tool_error("Project 43 not found"), expected: "project_lookup_denied", project_id: 42).first
    refute E.classify(tool_error("Not allowed to create this resource"), expected: "project_lookup_denied", project_id: 42).first
  end

  def test_internal_and_protocol_errors_never_prove_valid_identity_denial
    candidates = [tool_error("Tool execution failed: Not allowed to create this resource"),
                  tool_error("Tool execution failed: SQL failure"),
                  tool_error("This MCP token was issued without a sign-in method"),
                  response({ "error" => { "code" => -32602, "message" => "Invalid params" } }),
                  response({ "error" => { "code" => -32603, "message" => "Internal error" } }),
                  Response.new("500", "error"), Response.new("200", "[]")]
    candidates.each do |r|
      %w[create_policy_denied project_lookup_denied administrative_tool_not_published].each do |expected|
        refute E.classify(r, expected: expected, project_id: 42).first
      end
    end
  end

  def test_authentication_denial_cannot_prove_authorization
    r = response({ "id" => nil, "error" => { "code" => -32000, "message" => "Unauthorized: valid session key required" } }, status: "401")
    assert E.classify(r, expected: "authentication_denied").first
    %w[create_policy_denied project_lookup_denied administrative_tool_not_published].each do |expected|
      refute E.classify(r, expected: expected, project_id: 42).first
    end
    refute E.classify(Response.new("401", "{}"), expected: "authentication_denied").first
  end

  def test_worker_requires_specific_tool_lookup_error
    payload = { "error" => { "code" => -32602, "message" => "Tool not found: update_project_settings" } }
    ok, evidence = E.classify(response(payload), expected: "administrative_tool_not_published")
    assert ok
    assert_equal({ denial_category: "administrative_tool_not_published", rpc_code: -32602 }, evidence)

    # Official Ruby MCP SDK error format: message is "Invalid params" and detail is in "data"
    sdk_payload = { "error" => { "code" => -32602, "message" => "Invalid params", "data" => "Tool not found: update_project_settings" } }
    ok_sdk, evidence_sdk = E.classify(response(sdk_payload), expected: "administrative_tool_not_published")
    assert ok_sdk
    assert_equal({ denial_category: "administrative_tool_not_published", rpc_code: -32602 }, evidence_sdk)

    refute E.classify(response(payload, status: "400"), expected: "administrative_tool_not_published").first
    payload["error"]["code"] = -32603
    refute E.classify(response(payload), expected: "administrative_tool_not_published").first
    payload["error"]["code"] = -32602
    payload["error"]["message"] = "Tool not found: another_tool"
    refute E.classify(response(payload), expected: "administrative_tool_not_published").first
  end

  def test_wrong_id_and_mixed_envelopes_fail_closed
    r = tool_error("Not allowed to create this resource")
    body = JSON.parse(r.body)
    body["id"] = 2
    refute E.classify(Response.new("200", JSON.generate(body)), expected: "create_policy_denied").first
    body["id"] = 1
    body["error"] = { "code" => -32603, "message" => "internal" }
    refute E.classify(Response.new("200", JSON.generate(body)), expected: "create_policy_denied").first
  end

  def test_catalog_and_positive_results_reject_errors
    assert_equal ["create_agent"], E.tool_names(response({ "result" => { "tools" => [{ "name" => "create_agent" }] } }))
    assert_nil E.tool_names(response({ "result" => { "tools" => [nil] } }))
    assert_nil E.tool_names(response({ "error" => { "code" => -32603 } }))
    refute E.success?(tool_error("Tool execution failed: failure"))
    assert E.success?(response({ "result" => { "content" => [{ "type" => "text", "text" => "ok" }] } }))
  end
end
