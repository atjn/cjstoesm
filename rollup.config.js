import ts from "@wessberg/rollup-plugin-ts";
import packageJson from "./package.json";
import {builtinModules} from "module";

const SHARED_OPTIONS = {
	plugins: [
		ts({
			tsconfig: process.env.NODE_ENV === "production" ? "tsconfig.dist.json" : "tsconfig.json"
		})
	],
	external: [
		...builtinModules,
		...Object.keys(packageJson.dependencies),
		...Object.keys(packageJson.devDependencies),
		...Object.keys(packageJson.peerDependencies)
	]
};

export default [
	{
		input: "src/index.ts",
		output: [
			{
				file: packageJson.main,
				format: "cjs",
				sourcemap: true
			},
			{
				file: packageJson.module,
				format: "esm",
				sourcemap: true
			}
		],
		...SHARED_OPTIONS
	},
	{
		input: "src/cli/index.ts",
		output: [
			{
				dir: "./dist/cli",
				format: "cjs",
				sourcemap: true
			}
		],
		...SHARED_OPTIONS
	}
];
