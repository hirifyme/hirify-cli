#!/usr/bin/env node
import { main } from './lib/main.js'
// Allow pipe output and cleanup to finish; deep modules never terminate the process.
process.exitCode = await main()
