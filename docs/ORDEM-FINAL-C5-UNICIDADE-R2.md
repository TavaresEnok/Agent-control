# Revisão independente — C5-UNICIDADE-R2

Examine a unicidade das duas séries por consulta, o caminho, a linha e a forma das métricas à luz do contrato do coletor.

Trecho do coletor em 1fc208e8 para a conferência da leitura e da medição.

```ruby

    def observe(source, identifier, line:)
      before = stats(identifier) || {}
      connect("fresh", readonly: true) do |db|
        SAMPLES.times do
          db.send_query_params(source.sql, [])
          db.set_single_row_mode
          while (result = db.get_result)
            result.check
            result.clear
          end
        end
      end
      after = stats(identifier) || {}
      calls = after.fetch("calls", "0").to_i - before.fetch("calls", "0").to_i
      raise ToolError, "pg_stat_statements registrou #{calls} de #{SAMPLES} chamadas esperadas" unless calls == SAMPLES

      mean = (after.fetch("total_exec_time").to_f - before.fetch("total_exec_time", "0").to_f) / calls
      blocks = %w[shared_blks_hit shared_blks_read].map do |key|
        after.fetch(key).to_i - before.fetch(key, "0").to_i
      end
      evidence = format("queryid=%d; amostras=%d; média=%.3f ms; blocos hit/read=%d/%d", identifier, calls, mean, *blocks)
      measured_sql = Digest::SHA256.hexdigest(source.sql)
      @report.cover("pg_stat_statements", "ok",
                    "pg_stat_statements:query:#{source.path}: linha #{line}; #{evidence} | SQL medido (sha256:#{measured_sql})",
                    files: [source.path])
      if mean >= SLOW_MS
        @report.find("pg_stat_statements", "BANCO-CONSULTA-LENTA", source, "media",
          "A consulta atingiu a média de #{SLOW_MS} ms na carga ensaiada.", evidence, line: line)
      end
    rescue PG::Error => error
```


Examinar 1fc208e8 contra 00706443. Somente leitura.
