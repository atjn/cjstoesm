import {BeforeVisitorOptions} from "../before-visitor-options";
import {isRequireCall} from "../../../util/is-require-call";
import {walkThroughFillerNodes} from "../../../util/walk-through-filler-nodes";
import {getModuleExportsFromRequireDataInContext} from "../../../util/get-module-exports-from-require-data-in-context";
import {TS} from "../../../../type/ts";
import {willReassignIdentifier} from "../../../util/will-be-reassigned";
import {hasExportModifier} from "../../../util/has-export-modifier";
import {findNodeUp} from "../../../util/find-node-up";
import {isNodeFactory} from "../../../util/is-node-factory";

/**
 * Visits the given VariableDeclaration
 */
export function visitVariableDeclaration({node, childContinuation, sourceFile, context, compatFactory}: BeforeVisitorOptions<TS.VariableDeclaration>): TS.VisitResult<TS.Node> {
	if (context.onlyExports || node.initializer == null) {
		return childContinuation(node);
	}

	const {typescript} = context;

	// Most sophisticated require(...) handling comes from the CallExpression visitor, but this Visitor is for rewriting simple
	// 'foo = require("bar")' or '{foo} = require("bar")' as well as '{foo: bar} = require("bar")' expressions

	const initializer = walkThroughFillerNodes(node.initializer, typescript);
	const statement = findNodeUp(node, typescript.isVariableStatement, n => typescript.isBlock(n) || typescript.isSourceFile(n));

	if (!typescript.isCallExpression(initializer)) {
		return childContinuation(node);
	}

	// Check if the initializer represents a require(...) call.
	const requireData = isRequireCall(initializer, sourceFile, context);

	// If it doesn't, proceed without applying any transformations
	if (!requireData.match) {
		return childContinuation(node);
	}

	// Otherwise, spread out the things we know about the require call
	const {moduleSpecifier, transformedModuleSpecifier} = requireData;

	// If no module specifier could be determined, proceed with the child continuation
	if (moduleSpecifier == null || transformedModuleSpecifier == null) {
		return childContinuation(node);
	}

	// If we've been able to resolve a module as well as its contents,
	// Check it for exports so that we know more about its internals, for example whether or not it has any named exports, etc
	const moduleExports = getModuleExportsFromRequireDataInContext(requireData, context);

	// This will be something like 'foo = require("bar")
	if (typescript.isIdentifier(node.name)) {
		// If the default export is already imported under the same local name as this VariableDeclaration binds,
		// proceed from the child continuation for more sophisticated behavior
		if ((moduleExports == null || moduleExports.hasDefaultExport) && context.hasLocalForDefaultImportFromModule(moduleSpecifier)) {
			return childContinuation(node);
		}

		// If the namespace is already imported, under the same local name as this VariableDeclaration binds,
		// proceed from the child continuation for more sophisticated behavior
		else if (moduleExports != null && !moduleExports.hasDefaultExport && context.hasLocalForNamespaceImportFromModule(moduleSpecifier)) {
			return childContinuation(node);
		}

		// Otherwise, the 'foo = require("bar")' VariableDeclaration is part of an Exported VariableStatement such as 'export const foo = require("bar")',
		// and it should preferably be converted into an ExportDeclaration
		else if (statement != null && hasExportModifier(statement, typescript)) {
			const moduleSpecifierExpression = compatFactory.createStringLiteral(transformedModuleSpecifier);

			if (moduleExports == null || moduleExports.hasDefaultExport) {
				const exportClause = compatFactory.createNamedExports([
					compatFactory.createExportSpecifier(node.name.text === "default" ? undefined : compatFactory.createIdentifier("default"), compatFactory.createIdentifier(node.name.text))
				]);

				context.addTrailingStatements(
					isNodeFactory(compatFactory)
						? compatFactory.createExportDeclaration(undefined, undefined, false, exportClause, moduleSpecifierExpression)
						: compatFactory.createExportDeclaration(undefined, undefined, exportClause, moduleSpecifierExpression)
				);
				return undefined;
			}
			// Otherwise, if the TypeScript version supports named namespace exports
			else if (compatFactory.createNamespaceExport != null) {
				const exportClause = compatFactory.createNamespaceExport(compatFactory.createIdentifier(node.name.text));

				context.addTrailingStatements(
					isNodeFactory(compatFactory)
						? compatFactory.createExportDeclaration(undefined, undefined, false, exportClause, moduleSpecifierExpression)
						: compatFactory.createExportDeclaration(undefined, undefined, exportClause, moduleSpecifierExpression)
				);
				return undefined;
			}

			// Otherwise, for older TypeScript versions, we'll have to first import and then re-export the namespace
			else {
				context.addImport(
					compatFactory.createImportDeclaration(
						undefined,
						undefined,
						isNodeFactory(compatFactory)
							? compatFactory.createImportClause(false, undefined, compatFactory.createNamespaceImport(compatFactory.createIdentifier(node.name.text)))
							: compatFactory.createImportClause(undefined, compatFactory.createNamespaceImport(compatFactory.createIdentifier(node.name.text))),
						moduleSpecifierExpression
					)
				);
				const exportClause = compatFactory.createNamedExports([compatFactory.createExportSpecifier(undefined, compatFactory.createIdentifier(node.name.text))]);
				context.addTrailingStatements(
					isNodeFactory(compatFactory)
						? compatFactory.createExportDeclaration(undefined, undefined, false, exportClause)
						: compatFactory.createExportDeclaration(undefined, undefined, exportClause)
				);
				return undefined;
			}
		}

		// Otherwise, the 'foo = require("bar")' VariableDeclaration can be safely transformed into a simple import such as 'import foo from "bar"' or 'import * as foo from "bar"',
		// depending on whether or not the module has a default export
		else {
			const willReassign = willReassignIdentifier(node.name.text, sourceFile, typescript);
			const newName = willReassign ? context.getFreeIdentifier(node.name.text, true) : node.name.text;

			context.addImport(
				compatFactory.createImportDeclaration(
					undefined,
					undefined,

					moduleExports == null || moduleExports.hasDefaultExport
						? // Import the default if it has any (or if we don't know if it has)
						  isNodeFactory(compatFactory)
							? compatFactory.createImportClause(false, compatFactory.createIdentifier(newName), undefined)
							: compatFactory.createImportClause(compatFactory.createIdentifier(newName), undefined)
						: // Otherwise, import the entire namespace
						isNodeFactory(compatFactory)
						? compatFactory.createImportClause(false, undefined, compatFactory.createNamespaceImport(compatFactory.createIdentifier(newName)))
						: compatFactory.createImportClause(undefined, compatFactory.createNamespaceImport(compatFactory.createIdentifier(newName))),
					compatFactory.createStringLiteral(transformedModuleSpecifier)
				)
			);
			if (willReassign) {
				// Now, immediately add a local mutable variable with the correct name
				context.addLeadingStatements(
					compatFactory.createVariableStatement(
						undefined,
						compatFactory.createVariableDeclarationList(
							[
								isNodeFactory(compatFactory)
									? compatFactory.createVariableDeclaration(node.name.text, undefined, undefined, compatFactory.createIdentifier(newName))
									: compatFactory.createVariableDeclaration(node.name.text, undefined, compatFactory.createIdentifier(newName))
							],
							typescript.NodeFlags.Let
						)
					)
				);
			}
			return undefined;
		}
	}

	// This will be something like '{foo} = require("bar")', '{foo, bar} = require("bar")', '{foo: bar} = require("bar")', or event '{foo: {bar: baz}} = require("bar")'.
	// We will only consider the simplest variants of these before opting out and letting the CallExpression visitor handle more sophisticated behavior
	else if (moduleExports != null && typescript.isObjectBindingPattern(node.name)) {
		const importSpecifiers: TS.ImportSpecifier[] = [];
		for (const element of node.name.elements) {
			// When the propertyName is null, the name will always be an identifier.
			// This will be something like '{foo} = require("bar")'
			if (element.propertyName == null && typescript.isIdentifier(element.name)) {
				// If there is no named export matching the identifier, opt out and proceed with the
				// child continuation for more sophisticated handling
				if (!moduleExports.namedExports.has(element.name.text)) {
					return childContinuation(node);
				}

				importSpecifiers.push(compatFactory.createImportSpecifier(undefined, compatFactory.createIdentifier(element.name.text)));
			}

			// This will be something like '{foo: bar} = require("bar")'
			else if (element.propertyName != null && typescript.isIdentifier(element.propertyName) && typescript.isIdentifier(element.name)) {
				// If there is no named export matching the identifier of the property name, opt out and proceed with the
				// child continuation for more sophisticated handling
				if (!moduleExports.namedExports.has(element.propertyName.text)) {
					return childContinuation(node);
				}

				importSpecifiers.push(compatFactory.createImportSpecifier(compatFactory.createIdentifier(element.propertyName.text), compatFactory.createIdentifier(element.name.text)));
			} else {
				// Opt out and proceed with the child continuation for more sophisticated handling
				return childContinuation(node);
			}
		}
		// If more than 0 import specifier was generated, add an ImportDeclaration and remove this VariableDeclaration
		if (importSpecifiers.length > 0) {
			const importSpecifiersThatWillBeReassigned = importSpecifiers.filter(importSpecifier => willReassignIdentifier(importSpecifier.name.text, sourceFile, typescript));
			const otherImportSpecifiers = importSpecifiers.filter(importSpecifier => !importSpecifiersThatWillBeReassigned.includes(importSpecifier));

			// Add an import, but bind the name to free identifier
			for (const importSpecifier of importSpecifiersThatWillBeReassigned) {
				const propertyName = importSpecifier.propertyName ?? importSpecifier.name;
				const newName = context.getFreeIdentifier(importSpecifier.name.text, true);

				const namedImports = compatFactory.createNamedImports([
					compatFactory.createImportSpecifier(compatFactory.createIdentifier(propertyName.text), compatFactory.createIdentifier(newName))
				]);

				context.addImport(
					compatFactory.createImportDeclaration(
						undefined,
						undefined,
						isNodeFactory(compatFactory) ? compatFactory.createImportClause(false, undefined, namedImports) : compatFactory.createImportClause(undefined, namedImports),
						compatFactory.createStringLiteral(transformedModuleSpecifier)
					)
				);

				// Now, immediately add a local mutable variable with the correct name
				context.addLeadingStatements(
					compatFactory.createVariableStatement(
						undefined,
						compatFactory.createVariableDeclarationList(
							[
								isNodeFactory(compatFactory)
									? compatFactory.createVariableDeclaration(importSpecifier.name.text, undefined, undefined, compatFactory.createIdentifier(newName))
									: compatFactory.createVariableDeclaration(importSpecifier.name.text, undefined, compatFactory.createIdentifier(newName))
							],
							typescript.NodeFlags.Let
						)
					)
				);
			}

			if (otherImportSpecifiers.length > 0) {
				context.addImport(
					compatFactory.createImportDeclaration(
						undefined,
						undefined,
						isNodeFactory(compatFactory)
							? compatFactory.createImportClause(false, undefined, compatFactory.createNamedImports(otherImportSpecifiers))
							: compatFactory.createImportClause(undefined, compatFactory.createNamedImports(otherImportSpecifiers)),
						compatFactory.createStringLiteral(transformedModuleSpecifier)
					)
				);
			}

			return undefined;
		}
	}

	// Otherwise, proceed with the child continuation
	return childContinuation(node);
}
