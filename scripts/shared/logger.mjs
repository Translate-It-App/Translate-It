// build-scripts/logger.js

/* eslint-disable no-undef */

import chalk from "chalk";

export function logSuccess(message) {
  console.log(chalk.green.bold('✅ ' + message))
}

export function logError(message, details) {
  console.log(chalk.red.bold('❌ ' + message))
  if (details) {
    console.log(chalk.red('   ' + details))
  }
}

export function logInfo(message) {
  console.log(chalk.blue('ℹ️  ' + message))
}

export function logStep(name) {
  console.log(chalk.white.bold(`\n${name}\n`));
}
