# frozen_string_literal: true

require "json"

module F0Access
  # Evidence classifier only. No application handler or authorization override.
  # Never retain response text: messages from internal errors may contain data.
  module MCPEvidence
    module_function

    def classify(response, expected:, project_id: nil)
      body = JSON.parse(response.body)
      envelope = body.is_a?(Hash) && body["jsonrpc"] == "2.0"
      category = "unexpected_response"
      code = nil
      if envelope && response.code == "401" && body["id"].nil? && !body.key?("result") &&
          body["error"] == { "code" => -32000, "message" => "Unauthorized: valid session key required" }
        category = "authentication_denied"
        code = -32000
      elsif envelope && response.code == "200" && body["id"] == 1
        result = body["result"]
        error = body["error"]
        if !body.key?("error") && result.is_a?(Hash) && result["isError"] == true
          content = result["content"]
          if content.is_a?(Array) && content.length == 1 && content[0].is_a?(Hash) && content[0]["type"] == "text"
            category = case content[0]["text"]
            when "Not allowed to create this resource" then "create_policy_denied"
            when "Project #{project_id} not found" then project_id ? "project_lookup_denied" : "unexpected_response"
            else "unexpected_tool_error"
            end
          end
        elsif !body.key?("result") && error.is_a?(Hash)
          # SDK tool lookup refusal only; invalid envelopes/arguments, unknown
          # methods, HTTP errors and generic server errors cannot satisfy this.
          code = error["code"] if error["code"].is_a?(Integer)
          detail = (error["data"].is_a?(String) && !error["data"].empty?) ? error["data"] : error["message"]
          if code == -32602 && detail == "Tool not found: update_project_settings"
            category = "administrative_tool_not_published"
          else
            category = "unexpected_protocol_error"
          end
        end
      end
      [category == expected, { denial_category: category, rpc_code: code }]
    rescue JSON::ParserError, TypeError
      [false, { denial_category: "invalid_json", rpc_code: nil }]
    end

    def tool_names(response)
      body = JSON.parse(response.body)
      return unless response.code == "200" && body.is_a?(Hash) && body["jsonrpc"] == "2.0" &&
        body["id"] == 1 && !body.key?("error")

      tools = body.dig("result", "tools")
      return unless tools.is_a?(Array) && tools.all? { |tool| tool.is_a?(Hash) && tool["name"].is_a?(String) }

      tools.map { |tool| tool["name"] }
    rescue JSON::ParserError, TypeError
      nil
    end

    def success?(response)
      body = JSON.parse(response.body)
      response.code == "200" && body.is_a?(Hash) && body["jsonrpc"] == "2.0" && body["id"] == 1 &&
        !body.key?("error") && body["result"].is_a?(Hash) &&
        [nil, false].include?(body["result"]["isError"]) && body["result"]["content"].is_a?(Array)
    rescue JSON::ParserError, TypeError
      false
    end
  end
end
