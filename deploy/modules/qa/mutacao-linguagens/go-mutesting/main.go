// Generate edits from the pinned go-mutesting arithmetic mutator, without running project code.
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"runtime/debug"
	"unicode/utf8"

	"github.com/avito-tech/go-mutesting/mutator/arithmetic"
)

const maxCandidates = 512

type edit struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Before string `json:"before"`
	After  string `json:"after"`
}

type plan struct {
	Edits     []edit   `json:"edits"`
	Omitted   []string `json:"omitted"`
	Truncated bool     `json:"truncated"`
}

func scan(path string, out *plan) {
	src, err := os.ReadFile(path)
	if err != nil || !utf8.Valid(src) {
		out.Omitted = append(out.Omitted, path)
		return
	}
	fset := token.NewFileSet()
	tree, err := parser.ParseFile(fset, path, src, parser.SkipObjectResolution)
	if err != nil {
		out.Omitted = append(out.Omitted, path)
		return
	}
	ast.Inspect(tree, func(node ast.Node) bool {
		if out.Truncated {
			return false
		}
		binary, ok := node.(*ast.BinaryExpr)
		if !ok {
			return true
		}
		original := binary.Op.String()
		pos := fset.PositionFor(binary.OpPos, false)
		for _, mutation := range arithmetic.MutatorArithmeticBase(nil, nil, binary) {
			if len(out.Edits) == maxCandidates {
				out.Truncated = true
				return false
			}
			mutation.Change()
			replacement := binary.Op.String()
			mutation.Reset()
			// Go reports a byte column. The API reports a 1-based Unicode column.
			prefix := src[pos.Offset-pos.Column+1 : pos.Offset]
			column := utf8.RuneCount(prefix) + 1
			out.Edits = append(out.Edits, edit{path, pos.Line, column, original, replacement})
		}
		return true
	})
}

func main() {
	encoder := json.NewEncoder(os.Stdout)
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		info, ok := debug.ReadBuildInfo()
		if ok {
			for _, dep := range info.Deps {
				if dep.Path == "github.com/avito-tech/go-mutesting" && dep.Replace == nil {
					if encoder.Encode(dep.Version) == nil {
						return
					}
				}
			}
		}
		os.Exit(1)
	}
	result := plan{Edits: []edit{}, Omitted: []string{}}
	for _, path := range os.Args[1:] {
		scan(path, &result)
		if result.Truncated {
			break
		}
	}
	if encoder.Encode(result) != nil {
		os.Exit(1)
	}
}
