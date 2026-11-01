# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "base64"
require "digest"

class AcRemoteEnvironmentTest < ActiveSupport::TestCase
  setup do
    @company = create(:company)
    @user = create(:user, company: @company)
    @project = create(:project, company: @company, owner: @user)

    @dir = Dir.mktmpdir("ac_remote_env_test")
    @identity_path = File.join(@dir, "id_ed25519")
    @known_hosts_path = File.join(@dir, "known_hosts")
    File.write(@identity_path, "synthetic private key")

    key_blob = Base64.strict_encode64("synthetic-ed25519-public-key")
    File.write(@known_hosts_path, "f0-lab-pinned ssh-ed25519 #{key_blob}\n")
    @fingerprint = "SHA256:#{Base64.strict_encode64(Digest::SHA256.digest(Base64.decode64(key_blob))).delete_suffix('=')}"

    @valid_attributes = {
      company: @company,
      project: @project,
      name: "NexoISP Test Target",
      environment_slug: "nexoisp-test",
      host: "127.0.0.1",
      port: 22,
      user: "deploy",
      fingerprint: @fingerprint,
      identity_key_path: @identity_path,
      known_hosts_path: @known_hosts_path,
      authorized_directories: ["/home/enok/Documentos/projetos/nexoisp"],
      state: "active"
    }
  end

  teardown do
    FileUtils.remove_entry(@dir) if @dir && Dir.exist?(@dir)
  end

  test "validates required fields" do
    env = AcRemoteEnvironment.new(@valid_attributes)
    assert env.valid?, env.errors.full_messages.to_sentence

    %i[name environment_slug host user fingerprint identity_key_path known_hosts_path].each do |field|
      bad_env = AcRemoteEnvironment.new(@valid_attributes.merge(field => nil))
      refute bad_env.valid?, "Expected #{field} to be required"
    end
  end

  test "validates port numericality and range" do
    assert AcRemoteEnvironment.new(@valid_attributes.merge(port: 22)).valid?
    assert AcRemoteEnvironment.new(@valid_attributes.merge(port: 2222)).valid?

    refute AcRemoteEnvironment.new(@valid_attributes.merge(port: 0)).valid?
    refute AcRemoteEnvironment.new(@valid_attributes.merge(port: 70000)).valid?
    refute AcRemoteEnvironment.new(@valid_attributes.merge(port: -1)).valid?
  end

  test "validates environment_slug uniqueness per company and format" do
    AcRemoteEnvironment.create!(@valid_attributes)

    dup_env = AcRemoteEnvironment.new(@valid_attributes)
    refute dup_env.valid?
    assert_includes dup_env.errors[:environment_slug], "has already been taken"

    other_company = create(:company)
    other_user = create(:user, company: other_company)
    other_project = create(:project, company: other_company, owner: other_user)
    diff_company_env = AcRemoteEnvironment.new(@valid_attributes.merge(company: other_company, project: other_project))
    assert diff_company_env.valid?

    bad_format = AcRemoteEnvironment.new(@valid_attributes.merge(environment_slug: "INVALID SLUG!"))
    refute bad_format.valid?
  end

  test "validates authorized_directories must be an array of absolute paths" do
    refute AcRemoteEnvironment.new(@valid_attributes.merge(authorized_directories: [])).valid?
    refute AcRemoteEnvironment.new(@valid_attributes.merge(authorized_directories: nil)).valid?
    refute AcRemoteEnvironment.new(@valid_attributes.merge(authorized_directories: ["relative/path"])).valid?
    refute AcRemoteEnvironment.new(@valid_attributes.merge(authorized_directories: [""])).valid?

    assert AcRemoteEnvironment.new(@valid_attributes.merge(authorized_directories: ["/home/enok/Documentos/projetos/nexoisp", "/var/log/nexoisp"])).valid?
  end

  test "directory_authorized? enforces exact path or subpath containment and rejects traversals" do
    env = AcRemoteEnvironment.create!(@valid_attributes)

    assert env.directory_authorized?("/home/enok/Documentos/projetos/nexoisp")
    assert env.directory_authorized?("/home/enok/Documentos/projetos/nexoisp/app/models")
    assert env.directory_authorized?("/home/enok/Documentos/projetos/nexoisp/config/database.yml")

    refute env.directory_authorized?("/home/enok/Documentos/projetos")
    refute env.directory_authorized?("/home/enok/Documentos/projetos/ajust_erp")
    refute env.directory_authorized?("/etc/passwd")
    refute env.directory_authorized?("/tmp")
    refute env.directory_authorized?("/home/enok/Documentos/projetos/nexoisp/../../etc")
  end

  test "build_transport builds an OpenSshTransport instance" do
    env = AcRemoteEnvironment.create!(@valid_attributes)
    transport = env.build_transport(lab_opt_in: true)

    assert_instance_of AgentControl::OpenSshTransport, transport
    argv = transport.argv("uptime")
    assert_includes argv, "--"
    assert_includes argv, "deploy@127.0.0.1"
    assert_includes argv, "uptime"
  end
end
