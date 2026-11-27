group "default" { targets = ["common"] }

target "verify" {
  context = "deploy"
  dockerfile = "Dockerfile.verify"
}
target "qa" { context = "deploy/modules/qa" }
target "arquitetura" { context = "deploy/modules/arquitetura" }
target "dependencias" { context = "deploy/modules/dependencias" }
target "banco" { context = "deploy/modules/banco" }
target "prontidao" { context = "deploy/modules/prontidao" }
target "desempenho" { context = "deploy/modules/desempenho" }
target "documentacao" { context = "deploy/modules/documentacao" }
target "conformidade" { context = "deploy/modules/conformidade" }

target "common" {
  context = "deploy/simple-tools"
  contexts = {
    verify = "target:verify"
    qa = "target:qa"
    arquitetura = "target:arquitetura"
    dependencias = "target:dependencias"
    banco = "target:banco"
    prontidao = "target:prontidao"
    desempenho = "target:desempenho"
    documentacao = "target:documentacao"
    conformidade = "target:conformidade"
  }
  tags = ["agent-control-exam-tools:simple"]
}
