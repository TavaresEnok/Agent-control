# frozen_string_literal: true

class AcTemplate < ApplicationRecord
  belongs_to :company
  validates :template_key, presence: true, format: { with: /\A[a-zA-Z0-9_-]{1,100}\z/ }
  validates :version, numericality: { only_integer: true, greater_than: 0 }
  validates :title, presence: true, length: { maximum: 255 }
  validate :valid_plan_definition

  private

  def valid_plan_definition
    tasks = definition.is_a?(Hash) && definition["tasks"]
    unless tasks.is_a?(Array) && tasks.size.between?(1, 200) && tasks.all? { |task| task.is_a?(Hash) }
      errors.add(:definition, "must contain 1 to 200 tasks")
      return
    end
    keys = tasks.map { |task| task["task_key"] }
    valid = keys.all? { |key| key.is_a?(String) && key.match?(/\A[a-zA-Z0-9_-]{1,100}\z/) } && keys.uniq.size == keys.size
    valid &&= tasks.all? do |task|
      task["title"].is_a?(String) && task["title"].length.between?(1, 255) &&
        task.fetch("depends_on", []).is_a?(Array) && task.fetch("depends_on", []).all? { |key| keys.include?(key) }
    end
    unless valid
      errors.add(:definition, "contains invalid tasks or dependencies")
      return
    end
    dependencies = tasks.to_h { |task| [ task["task_key"], task.fetch("depends_on", []).dup ] }
    until dependencies.empty?
      ready = dependencies.select { |_key, deps| deps.empty? }.keys
      if ready.empty?
        errors.add(:definition, "contains a dependency cycle")
        return
      end
      ready.each { |key| dependencies.delete(key) }
      dependencies.each_value { |deps| deps.reject! { |key| ready.include?(key) } }
    end
  end
end
