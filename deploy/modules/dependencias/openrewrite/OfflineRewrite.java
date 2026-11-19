import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.jar.JarFile;
import org.openrewrite.ExecutionContext;
import org.openrewrite.InMemoryExecutionContext;
import org.openrewrite.Parser;
import org.openrewrite.PrintOutputCapture;
import org.openrewrite.Recipe;
import org.openrewrite.Result;
import org.openrewrite.SourceFile;
import org.openrewrite.internal.InMemoryLargeSourceSet;
import org.openrewrite.java.Java17Parser;
import org.openrewrite.java.JavaIsoVisitor;
import org.openrewrite.java.JavaParser;
import org.openrewrite.java.JavaPrinter;
import org.openrewrite.java.JavaTemplate;
import org.openrewrite.java.JavaVisitor;
import org.openrewrite.java.MethodMatcher;
import org.openrewrite.java.search.FindMissingTypes;
import org.openrewrite.java.tree.Expression;
import org.openrewrite.java.tree.J;
import org.openrewrite.java.tree.JavaType;
import org.openrewrite.java.tree.Space;
import org.openrewrite.java.tree.TypeUtils;

/** Runs one fixed recipe with the JDK classpath, against the collector's copies. */
public final class OfflineRewrite {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String CHARSET = "java.nio.charset.Charset";
    private static final String STANDARD_CHARSETS = "java.nio.charset.StandardCharsets";
    private static final String REPLACEMENT = STANDARD_CHARSETS + ".UTF_8";
    private static final int MAX_EDITS = 32;

    record Edit(int start, String before) {}

    record Report(String file, String error, int unproven, String beforeSha256, String afterSha256, List<Edit> edits) {
        static Report withoutEdits(String file, String error, int unproven) {
            return new Report(file, error, unproven, null, null, List.of());
        }
    }

    public static void main(String[] args) throws Exception {
        String core = jarVersion(Recipe.class);
        if (!core.equals(jarVersion(JavaParser.class)) || !core.equals(jarVersion(Java17Parser.class))) {
            throw new IllegalStateException("JARs OpenRewrite com versões divergentes");
        }
        System.out.println(JSON.writeValueAsString(Map.of("version", core, "jdk", Runtime.version().toString())));
        if (args.length == 1 && args[0].equals("--version")) return;
        if (args.length != 0) throw new IllegalArgumentException("Argumentos inesperados");

        try (var paths = Files.walk(Path.of("sources"), 2)) {
            for (Path file : paths.filter(Files::isRegularFile).sorted().toList()) {
                System.out.println(JSON.writeValueAsString(analyze(file)));
            }
        }
    }

    private static Report analyze(Path path) throws IOException {
        String file = path.getParent().getFileName().toString();
        String source = Files.readString(path);
        J.CompilationUnit parsed = parse(path, source);
        if (parsed == null) return Report.withoutEdits(file, "parse_java", 0);

        PreferStandardUtf8 recipe = new PreferStandardUtf8(parsed.getImports());
        List<Throwable> errors = new ArrayList<>();
        ExecutionContext ctx = new InMemoryExecutionContext(errors::add);
        List<Result> results = recipe.run(new InMemoryLargeSourceSet(List.of(parsed)), ctx, 1).getChangeset().getAllResults();
        if (!errors.isEmpty()) return Report.withoutEdits(file, "receita_java", 0);
        if (results.isEmpty() && recipe.replacements.isEmpty()) return Report.withoutEdits(file, null, recipe.unproven);
        if (results.size() != 1 || results.get(0).getBefore() != parsed || results.get(0).getAfter() == null) {
            return Report.withoutEdits(file, "resultado_java", 0);
        }
        // Missing project types can hide a declaration that shadows a JDK symbol.
        if (!FindMissingTypes.findMissingTypes(parsed, false).isEmpty()) {
            return Report.withoutEdits(file, null, recipe.unproven + recipe.replacements.size());
        }

        String after = results.get(0).getAfter().printAll(new PrintOutputCapture<>(0, PrintOutputCapture.MarkerPrinter.SANITIZED));
        J.CompilationUnit reparsed = parse(path, after);
        if (reparsed == null || countStandardUtf8(reparsed) - countStandardUtf8(parsed) != recipe.replacements.size()) {
            return Report.withoutEdits(file, null, recipe.unproven + recipe.replacements.size());
        }

        var printer = new EditPositions(recipe.replacements);
        var capture = new PrintOutputCapture<>(0, PrintOutputCapture.MarkerPrinter.SANITIZED);
        printer.visit(parsed, capture);
        if (!source.contentEquals(capture.out) || printer.edits.size() != recipe.replacements.size()) {
            return Report.withoutEdits(file, "localizacao_java", 0);
        }
        return new Report(file, null, recipe.unproven, sha256(source), sha256(after), printer.edits);
    }

    private static J.CompilationUnit parse(Path path, String source) {
        // A fresh compiler context keeps symbols from previously processed files out of attribution.
        JavaParser parser = Java17Parser.builder().classpath(List.of()).build();
        var errors = new ArrayList<Throwable>();
        var ctx = new InMemoryExecutionContext(errors::add);
        SourceFile parsed = parser.parseInputs(List.of(Parser.Input.fromString(path, source)), null, ctx)
            .findFirst().orElse(null);
        if (!errors.isEmpty() || !(parsed instanceof J.CompilationUnit cu)) return null;

        boolean[] erroneous = {false};
        new JavaIsoVisitor<boolean[]>() {
            @Override public J.Erroneous visitErroneous(J.Erroneous node, boolean[] found) {
                found[0] = true;
                return node;
            }
        }.visit(cu, erroneous);
        return erroneous[0] ? null : cu;
    }

    private static int countStandardUtf8(J.CompilationUnit cu) {
        int[] count = {0};
        new JavaIsoVisitor<int[]>() {
            @Override public J.FieldAccess visitFieldAccess(J.FieldAccess access, int[] found) {
                JavaType.Variable type = access.getName().getFieldType();
                if (type != null && type.getName().equals("UTF_8") && TypeUtils.isOfClassType(type.getOwner(), STANDARD_CHARSETS)) {
                    found[0]++;
                }
                return super.visitFieldAccess(access, found);
            }
        }.visit(cu, count);
        return count[0];
    }

    private static final class PreferStandardUtf8 extends Recipe {
        private static final MethodMatcher FOR_NAME = new MethodMatcher(CHARSET + " forName(java.lang.String)");
        private static final JavaTemplate UTF_8 = JavaTemplate.builder(REPLACEMENT)
            .javaParser(Java17Parser.builder().classpath(List.of())).build();
        private final Map<UUID, String> replacements = new HashMap<>();
        private final boolean importedCharset;
        private final boolean importedForName;
        private int unproven;

        PreferStandardUtf8(List<J.Import> imports) {
            importedCharset = imports.stream().anyMatch(i -> !i.isStatic() && CHARSET.equals(i.getTypeName()));
            importedForName = imports.stream().anyMatch(i -> i.isStatic() && CHARSET.equals(i.getTypeName())
                && i.getQualid().getSimpleName().equals("forName"));
        }

        @Override public String getDisplayName() { return "Usar StandardCharsets.UTF_8"; }

        @Override public String getDescription() { return "Substitui a busca do charset UTF-8 pela constante do JDK."; }

        @Override public JavaVisitor<ExecutionContext> getVisitor() {
            return new JavaVisitor<>() {
                @Override public J visitMethodInvocation(J.MethodInvocation method, ExecutionContext ctx) {
                    J.MethodInvocation call = (J.MethodInvocation) super.visitMethodInvocation(method, ctx);
                    if (!call.getSimpleName().equals("forName") || call.getArguments().size() != 1
                        || !(call.getArguments().get(0) instanceof J.Literal literal)
                        || !"\"UTF-8\"".equals(literal.getValueSource())) return call;

                    if (!TypeUtils.isWellFormedType(call.getMethodType())) {
                        unproven++;
                        return call;
                    }
                    if (!FOR_NAME.matches(call)) return call;

                    String before = call.withPrefix(Space.EMPTY).printTrimmed(getCursor());
                    if (!isTypeSelect(call.getSelect()) || !inValuePosition(getCursor().getParentTreeCursor().getValue())
                        || before.contains("/*") || before.contains("//") || before.length() > 256
                        || replacements.size() >= MAX_EDITS) {
                        unproven++;
                        return call;
                    }
                    replacements.put(call.getId(), before);
                    return UTF_8.apply(updateCursor(call), call.getCoordinates().replace());
                }
            };
        }

        private boolean isTypeSelect(Expression select) {
            // Java evaluates an instance receiver even when the invoked method is static.
            if (select == null) return importedForName;
            if (!TypeUtils.isOfClassType(select.getType(), CHARSET)) return false;
            if (select instanceof J.Identifier name) return importedCharset && name.getFieldType() == null;
            return select instanceof J.FieldAccess name && name.getName().getFieldType() == null
                && name.isFullyQualifiedClassReference(CHARSET);
        }

        private static boolean inValuePosition(Object parent) {
            // A method invocation can be a standalone statement; a field access cannot.
            return parent instanceof J.Return || parent instanceof J.VariableDeclarations.NamedVariable
                || parent instanceof J.Assignment || parent instanceof J.MethodInvocation || parent instanceof J.NewClass
                || parent instanceof J.Parentheses<?> || parent instanceof J.Ternary;
        }
    }

    private static final class EditPositions extends JavaPrinter<Integer> {
        private final Map<UUID, String> replacements;
        private final List<Edit> edits = new ArrayList<>();

        EditPositions(Map<UUID, String> replacements) {
            this.replacements = replacements;
        }

        @Override protected void beforeSyntax(J node, Space.Location location, PrintOutputCapture<Integer> capture) {
            super.beforeSyntax(node, location, capture);
            String before = replacements.get(node.getId());
            if (before != null) edits.add(new Edit(capture.out.length(), before));
        }
    }

    private static String jarVersion(Class<?> type) throws Exception {
        Path path = Path.of(type.getProtectionDomain().getCodeSource().getLocation().toURI());
        try (JarFile jar = new JarFile(path.toFile())) {
            String version = jar.getManifest().getMainAttributes().getValue("Implementation-Version");
            if (version == null) throw new IOException("JAR OpenRewrite sem versão");
            return version;
        }
    }

    private static String sha256(String content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
