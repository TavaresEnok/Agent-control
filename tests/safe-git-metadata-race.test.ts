import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Ruby comes from the lab image. This file does not install an interpreter.
 * A missing interpreter skips the proof; a skip is not an executed pass. */
function findRuby(): string | null {
  const candidates=['/usr/bin/ruby', ...(process.env.PATH ?? '').split(':').filter(Boolean).map(dir=>join(dir, 'ruby'))];
  return candidates.find(candidate=>existsSync(candidate)) ?? null;
}

const ruby=findRuby();
const rubySkip=ruby?false:'Ruby ausente neste runner. A prova não foi executada e não conta como sucesso; fica reservada a deploy/compose.lab.yml.';
const safeGit=fileURLToPath(new URL('../services/agent-control-git/ac_safe_git.rb', import.meta.url));

const proof=String.raw`
# frozen_string_literal: true
require "fileutils"
require "open3"
require "socket"
require "tmpdir"

safe_git = ARGV.fetch(0)
mode = ARGV.fetch(1)
require safe_git

def git!(*args)
  out, err, status = Open3.capture3("git", *args)
  abort(args.inspect + "\n" + out + err) unless status.success?
  out
end

def make_repo(root)
  repo = File.join(root, "repo")
  git!("init", repo)
  git!("-C", repo, "config", "user.name", "Fixture")
  git!("-C", repo, "config", "user.email", "fixture@invalid")
  File.write(File.join(repo, "tracked"), "base\n")
  git!("-C", repo, "add", "tracked")
  git!("-C", repo, "commit", "-m", "base")
  repo
end

def plant_probe(repo)
  dir = File.join(repo, ".git", "objects", "ab")
  Dir.mkdir(dir) unless File.directory?(dir)
  path = File.join(dir, "tmp_obj_probe")
  File.write(path, "probe")
  path
end

def historical_inspect(git_dir)
  Dir.glob(File.join(git_dir, "**", "*"), File::FNM_DOTMATCH).each do |path|
    info = File.lstat(path)
    raise ArgumentError, "Metadado Git deve ser arquivo regular ou diretório" unless info.file? || info.directory?
  end
end

def expect_refusal(repo, fragment)
  AcSafeGit.with_repository(repo) { |_| }
  abort("accepted " + fragment)
rescue ArgumentError => error
  abort("unexpected " + error.message) unless error.message.include?(fragment)
end

case mode
when "race"
  module InspectionGap
    class << self
      attr_accessor :count, :active
    end
    self.count = 0
    self.active = false
    def lstat(path)
      return super unless InspectionGap.active
      if path.end_with?("/objects/ab/tmp_obj_probe") && File.file?(path)
        InspectionGap.count += 1
        File.unlink(path)
      end
      super
    end
  end
  class << File
    prepend InspectionGap
  end
  Dir.mktmpdir("ac-race-") do |root|
    begin
      InspectionGap.active = true
      repo = make_repo(root)
      plant_probe(repo)
      begin
        historical_inspect(File.join(repo, ".git"))
        abort "HISTORICAL_DID_NOT_FAIL"
      rescue Errno::ENOENT
        puts "HISTORICAL_ENOENT"
      end
      abort("gap " + InspectionGap.count.to_s) unless InspectionGap.count == 1
      plant_probe(repo)
      AcSafeGit.with_repository(repo) { |_| }
      abort("gap " + InspectionGap.count.to_s) unless InspectionGap.count == 2
      puts "PATCHED_OK"
      plant_probe(repo)
      File.symlink("HEAD", File.join(repo, ".git", "linked-head"))
      expect_refusal(repo, "regular")
      puts "SYMLINK_BESIDE_GAP_OK"
    ensure
      # FileUtils lstats while removing the fixture. The gap must be off first.
      InspectionGap.active = false
    end
  end
when "operation"
  Dir.mktmpdir("ac-op-") do |root|
    repo = make_repo(root)
    git!("-C", repo, "config", "user.name", "Malicious")
    expected = git!("-C", repo, "rev-parse", "HEAD").strip
    out, err, status = AcSafeGit.capture("-C", repo, "rev-parse", "HEAD")
    abort(err) unless status.success? && out.strip == expected
    puts "REVPARSE_OK"
    out, _err, status = AcSafeGit.capture("-C", repo, "config", "--get", "user.name")
    abort("leaked " + out) if status.success? || out.include?("Malicious")
    puts "CONFIG_ISOLATED"
    hook = File.join(repo, ".git", "hooks", "pre-commit")
    File.write(hook, "#!/bin/sh\necho hook-ran\nexit 1\n")
    File.chmod(0o755, hook)
    File.write(File.join(repo, "added-by-safe"), "safe\n")
    _out, err, status = AcSafeGit.capture("-C", repo, "add", "--", "added-by-safe")
    abort(err) unless status.success?
    _out, err, status = AcSafeGit.capture("-C", repo, "commit", "-m", "safe-identity")
    abort(err) unless status.success?
    puts "HOOK_BYPASSED"
    name = git!("-C", repo, "log", "-1", "--format=%an").strip
    email = git!("-C", repo, "log", "-1", "--format=%ae").strip
    abort(name + " " + email) unless name == "Agent Control" && email == "agent-control@invalid"
    puts "IDENTITY_OK"
    _out, err, status = AcSafeGit.capture("-C", repo, "rev-parse", "--verify", "refs/heads/does-not-exist-ac")
    abort("git failure swallowed " + err) if status.success?
    puts "GIT_FAILURE_OK"
    AcSafeGit.with_repository(repo) do |metadata|
      config = File.read(File.join(metadata, "config"))
      abort(config) unless config == "[core]\nrepositoryformatversion = 0\nbare = true\n"
      abort "hooks copied" if File.exist?(File.join(metadata, "hooks"))
      %w[objects refs].each do |entry|
        link = File.join(metadata, entry)
        abort(entry) unless File.symlink?(link)
        abort(entry) unless File.realpath(link) == File.realpath(File.join(repo, ".git", entry))
      end
    end
    puts "METADATA_OK"
  end
when "negatives"
  Dir.mktmpdir("ac-neg-") do |root|
    repo = make_repo(root)
    File.symlink("HEAD", File.join(repo, ".git", "linked-head"))
    expect_refusal(repo, "regular")
    puts "SYMLINK_FILE_OK"
  end
  Dir.mktmpdir("ac-neg-git-") do |root|
    repo = make_repo(root)
    git = File.join(repo, ".git")
    moved = File.join(root, "real-git")
    File.rename(git, moved)
    File.symlink(moved, git)
    expect_refusal(repo, "autocontido")
    puts "SYMLINK_GITDIR_OK"
  end
  Dir.mktmpdir("ac-neg-fifo-") do |root|
    repo = make_repo(root)
    File.mkfifo(File.join(repo, ".git", "special.fifo"))
    expect_refusal(repo, "regular")
    puts "FIFO_OK"
  end
  Dir.mktmpdir("ac-neg-sock-") do |root|
    repo = make_repo(root)
    server = UNIXServer.new(File.join(repo, ".git", "special.sock"))
    begin
      expect_refusal(repo, "regular")
    ensure
      server.close
    end
    puts "SOCKET_OK"
  end
  Dir.mktmpdir("ac-neg-dev-") do |root|
    repo = make_repo(root)
    device = File.join(repo, ".git", "special.dev")
    stat = File.stat("/dev/null")
    if system("/bin/mknod", device, "c", stat.rdev_major.to_s, stat.rdev_minor.to_s)
      expect_refusal(repo, "regular")
      puts "DEVICE_OK"
    else
      puts "DEVICE_UNAVAILABLE"
    end
  end
  Dir.mktmpdir("ac-neg-alt-") do |root|
    repo = make_repo(root)
    info = File.join(repo, ".git", "objects", "info")
    Dir.mkdir(info) unless File.directory?(info)
    File.write(File.join(info, "alternates"), "/tmp/outside\n")
    expect_refusal(repo, "externa")
    puts "ALTERNATES_OK"
  end
  Dir.mktmpdir("ac-neg-common-") do |root|
    repo = make_repo(root)
    File.write(File.join(repo, ".git", "commondir"), "/tmp/outside\n")
    expect_refusal(repo, "externa")
    puts "COMMONDIR_OK"
  end
  Dir.mktmpdir("ac-neg-missing-") do |root|
    repo = File.join(root, "fake")
    Dir.mkdir(repo)
    git = File.join(repo, ".git")
    Dir.mkdir(git)
    Dir.mkdir(File.join(git, "objects"))
    File.write(File.join(git, "HEAD"), "ref: refs/heads/main\n")
    expect_refusal(repo, "incompletos")
    puts "MISSING_REFS_OK"
  end
  Dir.mktmpdir("ac-neg-yield-") do |root|
    repo = make_repo(root)
    begin
      AcSafeGit.with_repository(repo) { raise Errno::ENOENT, "depois da inspeção" }
      abort "yield swallowed"
    rescue Errno::ENOENT
      puts "YIELD_ENOENT_OK"
    end
    begin
      AcSafeGit.capture("-C", File.join(root, "ausente"), "status", "--porcelain")
      abort "capture root swallowed"
    rescue Errno::ENOENT
      puts "CAPTURE_ROOT_OK"
    end
  end
when "essential"
  relative = ARGV.fetch(2)
  abort "relative" if relative.empty? || relative.include?("..") || relative.start_with?("/")
  module EssentialGap
    class << self
      attr_accessor :git_dir, :relative, :active
    end
    self.active = false
    def glob(*args)
      return super unless EssentialGap.active
      paths = super
      git_dir = EssentialGap.git_dir
      wanted = EssentialGap.relative
      pattern = args[0]
      if git_dir && wanted && pattern.is_a?(String) && pattern.start_with?(git_dir)
        extra = File.join(git_dir, wanted)
        paths << extra unless paths.include?(extra)
      end
      paths
    end
    def lstat(path)
      return super unless EssentialGap.active
      git_dir = EssentialGap.git_dir
      wanted = EssentialGap.relative
      raise Errno::ENOENT, path if git_dir && wanted && path == File.join(git_dir, wanted)
      super
    end
  end
  class << Dir
    prepend EssentialGap
  end
  class << File
    prepend EssentialGap
  end
  Dir.mktmpdir("ac-essential-") do |root|
    begin
      EssentialGap.active = true
      repo = make_repo(root)
      EssentialGap.git_dir = File.join(File.realpath(repo), ".git")
      EssentialGap.relative = relative
      begin
        AcSafeGit.with_repository(repo) { |_| }
        abort "tolerated " + relative
      rescue Errno::ENOENT
        puts "ESSENTIAL_ENOENT"
      end
    ensure
      EssentialGap.active = false
      EssentialGap.git_dir = nil
      EssentialGap.relative = nil
    end
  end
when "classify"
  module ClassifyGap
    class << self
      attr_accessor :git_dir, :relative, :active
    end
    self.active = false
    def glob(*args)
      return super unless ClassifyGap.active
      paths = super
      git_dir = ClassifyGap.git_dir
      wanted = ClassifyGap.relative
      pattern = args[0]
      if paths.is_a?(Array) && git_dir && wanted && pattern.is_a?(String) && pattern.start_with?(git_dir)
        extra = File.join(git_dir, wanted)
        paths << extra unless paths.include?(extra)
      end
      paths
    end
    def lstat(path)
      return super unless ClassifyGap.active
      git_dir = ClassifyGap.git_dir
      wanted = ClassifyGap.relative
      raise Errno::ENOENT, path if git_dir && wanted && path == File.join(git_dir, wanted)
      super
    end
  end
  class << Dir
    prepend ClassifyGap
  end
  class << File
    prepend ClassifyGap
  end
  cases = [
    ["objects/pack/tmp_pack_probe", "pass"],
    ["index.lock", "pass"],
    ["refs/heads/feature.lock", "pass"],
    ["packed-refs.lock", "pass"],
    ["description", "raise"],
    ["config", "raise"],
    ["hooks/pre-commit", "raise"],
    ["objects/ab/permanent", "raise"],
    ["hooks/tmp_obj_fake", "raise"],
    [".", "raise"],
    ["..", "raise"],
    ["objects/.", "raise"]
  ]
  Dir.mktmpdir("ac-classify-") do |root|
    begin
      ClassifyGap.active = true
      repo = make_repo(root)
      ClassifyGap.git_dir = File.join(File.realpath(repo), ".git")
      cases.each do |relative, outcome|
        abort "relative" if relative.empty? || relative.start_with?("/")
        ClassifyGap.relative = relative
        begin
          AcSafeGit.with_repository(repo) { |_| }
          abort("swallowed " + relative) unless outcome == "pass"
          puts "IGNORED " + relative
        rescue Errno::ENOENT
          abort("refused transient " + relative) unless outcome == "raise"
          puts "PROPAGATED " + relative
        end
      end
    ensure
      ClassifyGap.active = false
      ClassifyGap.git_dir = nil
      ClassifyGap.relative = nil
    end
  end
else
  abort "modo desconhecido"
end
`;

function run(mode: string, relative?: string) {
  const directory=mkdtempSync(join(tmpdir(), 'ac-safe-git-proof-'));
  const script=join(directory, 'proof.rb');
  writeFileSync(script, proof);
  try {
    return spawnSync(ruby ?? 'ruby', [script, safeGit, mode, ...(relative ? [relative] : [])], {encoding: 'utf8', timeout: 120000});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

function assertRan(mode: string, token: string, relative?: string) {
  const result=run(mode, relative);
  assert.equal(result.status, 0, `status ${result.status} signal ${result.signal}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(token));
}

test('deterministic glob/lstat gap fails on the historical walk and passes on AcSafeGit', {skip: rubySkip}, () => {
  const result=run('race');
  assert.equal(result.status, 0, `status ${result.status} signal ${result.signal}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /HISTORICAL_ENOENT/);
  assert.match(result.stdout, /PATCHED_OK/);
  assert.match(result.stdout, /SYMLINK_BESIDE_GAP_OK/);
});

test('real git operation keeps isolated config, hooks and author identity', {skip: rubySkip}, () => {
  const result=run('operation');
  assert.equal(result.status, 0, `status ${result.status} signal ${result.signal}\n${result.stdout}\n${result.stderr}`);
  for (const token of ['REVPARSE_OK', 'CONFIG_ISOLATED', 'HOOK_BYPASSED', 'IDENTITY_OK', 'GIT_FAILURE_OK', 'METADATA_OK']) {
    assert.match(result.stdout, new RegExp(token));
  }
});

test('symlinks, special files, external refs, missing metadata and later ENOENT stay refused', {skip: rubySkip}, () => {
  const result=run('negatives');
  assert.equal(result.status, 0, `status ${result.status} signal ${result.signal}\n${result.stdout}\n${result.stderr}`);
  for (const token of ['SYMLINK_FILE_OK', 'SYMLINK_GITDIR_OK', 'FIFO_OK', 'SOCKET_OK', 'ALTERNATES_OK', 'COMMONDIR_OK', 'MISSING_REFS_OK', 'YIELD_ENOENT_OK', 'CAPTURE_ROOT_OK']) {
    assert.match(result.stdout, new RegExp(token));
  }
  assert.match(result.stdout, /DEVICE_OK|DEVICE_UNAVAILABLE/);
});

for (const relative of ['objects', 'refs', 'HEAD', 'packed-refs', 'shallow', 'commondir', 'objects/info/alternates']) {
  test(`inspection ENOENT on essential ${relative} is not ignored`, {skip: rubySkip}, () => {
    assertRan('essential', 'ESSENTIAL_ENOENT', relative);
  });
}

test('vanished temp names are ignored and other inspection ENOENT still propagates', {skip: rubySkip}, () => {
  const result=run('classify');
  assert.equal(result.status, 0, `status ${result.status} signal ${result.signal}\n${result.stdout}\n${result.stderr}`);
  for (const relative of ['objects/pack/tmp_pack_probe', 'index.lock', 'refs/heads/feature.lock', 'packed-refs.lock']) {
    assert.ok(result.stdout.split('\n').includes(`IGNORED ${relative}`), result.stdout);
  }
  for (const relative of ['description', 'config', 'hooks/pre-commit', 'objects/ab/permanent', 'hooks/tmp_obj_fake', '.', '..', 'objects/.']) {
    assert.ok(result.stdout.split('\n').includes(`PROPAGATED ${relative}`), result.stdout);
  }
});
