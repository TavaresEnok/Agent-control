group "default" { targets = ["common"] }

# Set by `npm run personal:tools-image`: the image is built as a candidate and only becomes the common
# image after its proof, and it carries the ownership labels of the installation that built it.
variable "AC_TOOLS_TAG" { default = "agent-control-exam-tools:candidate" }
variable "AC_INSTALLATION" { default = "" }

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
  tags = [AC_TOOLS_TAG]
  labels = AC_INSTALLATION == "" ? {} : {
    "com.agent-control.installation" = AC_INSTALLATION
    "com.agent-control.kind" = "exam-tools"
  }
}
