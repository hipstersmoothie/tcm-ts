export * from "./types.ts";
export * from "./hash.ts";
export { docExamples, docTags, exampleNames, statementStarts, type DocExample, type DocTag } from "./docs.ts";
export { cacheRefOf, matchShapes, queryShape, shapeBuilder, type QueryImport, type Shape, type ShapeMatch, type TypeShape } from "./shape.ts";
export { analyzeFile, analyzeProject, saltOf, scratchNamespace, type Analysis, type AnalyzeHost, type ProjectAnalysis, type ProjectDef, type WatchRecord } from "./analyze.ts";
export { TcmError } from "./extract.ts";
export { checkArgs, checkValue, paramsSchema, schemaCheckerSource, schemaText, typeSchema, type ParamsSchema, type Schema, type TableSchema } from "./schema.ts";
export { checkProfile, incrementalCompiler, packageNameOf, projectCompilerOptions, type Compile, type PackageResolver, transpileForNode, transpileModuleUrl, type CheckProfile, TS_VERSION, typescriptUrl, tcmTypeRoots, type Diagnostic } from "./program.ts";
export { compareVersions, compatRange, isExactVersion, satisfies } from "./semver.ts";
