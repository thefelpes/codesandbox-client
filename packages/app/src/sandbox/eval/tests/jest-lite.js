// @flow
import { dispatch, actions, listen } from 'codesandbox-api';
import expect from 'jest-matchers';
import jestMock from 'jest-mock';
import jestTestHooks from 'jest-circus';
import run from './run-circus';
import { makeDescribe } from 'jest-circus/build/utils';

import {
  addSerializer,
  toMatchSnapshot,
  toThrowErrorMatchingSnapshot,
} from 'jest-snapshot';

import {
  addEventHandler,
  setState,
  dispatch as dispatchJest,
  ROOT_DESCRIBE_BLOCK_NAME,
} from 'jest-circus/build/state';

import type Manager from '../manager';
import type { Module } from '../entities/module';

import { parse } from '../../react-error-overlay/utils/parser';
import { map } from '../../react-error-overlay/utils/mapper';
import type {
  Event,
  TestEntry,
  DescribeBlock,
  TestName,
  TestFn,
} from './types';

expect.extend({
  toMatchSnapshot,
  toThrowErrorMatchingSnapshot,
});
(expect: Object).addSnapshotSerializer = addSerializer;

function resetTestState() {
  const ROOT_DESCRIBE_BLOCK = makeDescribe(ROOT_DESCRIBE_BLOCK_NAME);
  const INITIAL_STATE = {
    currentDescribeBlock: ROOT_DESCRIBE_BLOCK,
    expand: undefined,
    hasFocusedTests: false,
    rootDescribeBlock: ROOT_DESCRIBE_BLOCK,
    testTimeout: 5000,
  };

  expect.setState({
    assertionCalls: 0,
    expectedAssertionsNumber: null,
    isExpectingAssertions: false,
    suppressedErrors: [],
    testPath: null,
    currentTestName: null,
    snapshotState: null,
  });

  setState(INITIAL_STATE);
}

export default class TestRunner {
  tests: Array<Module>;
  ranTests: Set<string>;
  manager: Manager;
  watching: boolean = true;

  constructor(manager: Manager) {
    this.manager = manager;
    this.ranTests = new Set();

    addEventHandler(this.handleMessage);
    listen(this.handleCodeSandboxMessage);
  }

  testGlobals(module: Module) {
    const test = (testName: TestName, fn?: TestFn) =>
      dispatchJest({
        fn,
        name: 'add_test',
        testName: `${module.path}:#:${testName}`,
      });
    const it = test;
    test.skip = (testName: TestName, fn?: TestFn) =>
      dispatchJest({
        fn,
        mode: 'skip',
        name: 'add_test',
        testName: `${module.path}:#:${testName}`,
      });
    test.only = (testName: TestName, fn: TestFn) => {
      dispatchJest({
        fn,
        mode: 'only',
        name: 'add_test',
        testName: `${module.path}:#:${testName}`,
      });
    };

    return {
      ...jestTestHooks,
      expect,
      jest: jestMock,
      test,
      it,
    };
  }

  static isTest(path: string) {
    let matched = false;

    if (
      path.includes('__tests__') &&
      (path.endsWith('.js') || path.endsWith('.ts'))
    ) {
      matched = true;
    }
    if (path.endsWith('.test.js') || path.endsWith('.test.ts')) {
      matched = true;
    }
    if (path.endsWith('.spec.js') || path.endsWith('.spec.ts')) {
      matched = true;
    }
    return matched;
  }

  findTests(modules: { [path: string]: Module }) {
    if (this.tests) {
      this.tests.forEach(t => {
        if (!modules[t.path]) {
          // A removed test
          this.sendMessage('remove_file', { path: t.path });
        }
      });
    }
    this.tests = Object.keys(modules)
      .filter(TestRunner.isTest)
      .map(p => modules[p]);
  }

  /* istanbul ignore next */
  async transpileTests() {
    return Promise.all(
      this.tests.map(async t => {
        const tModule = this.manager.getTranspiledModule(t, '');
        if (
          tModule.source &&
          tModule.compilation &&
          this.ranTests.has(t.path)
        ) {
          // We cached this test, don't run it again. We only run tests of changed
          // files
          return null;
        }

        this.sendMessage('add_file', { path: t.path });
        try {
          await this.manager.transpileModules(t, true);

          if (!t.source) {
            this.ranTests.delete(t.path);
          }

          return t;
        } catch (e) {
          const error = await this.errorToCodeSandbox(e);
          this.ranTests.delete(t.path);
          this.sendMessage('file_error', { path: t.path, error });

          return null;
        }
      })
    );
  }

  sendMessage(event: string, message: any = {}) {
    dispatch({
      type: 'test',
      event,
      ...message,
    });
  }

  /* istanbul ignore next */
  async runTests(force: boolean = false) {
    if (!this.watching && !force) {
      return;
    }

    this.sendMessage('total_test_start');
    // $FlowIssue
    const tests: Array<Module> = (await this.transpileTests()).filter(t => t);

    resetTestState();

    await Promise.all(
      tests.map(async t => {
        try {
          this.manager.evaluateModule(t);
          this.ranTests.add(t.path);
        } catch (e) {
          this.ranTests.delete(t.path);
          const error = await this.errorToCodeSandbox(e);
          this.sendMessage('file_error', { path: t.path, error });
        }
      })
    );

    await run();

    setTimeout(() => {
      this.sendMessage('total_test_end');
    });
  }

  async errorToCodeSandbox(
    error: Error & {
      matcherResult?: boolean,
    }
  ) {
    const parsedError = parse(error);
    const mappedErrors = await map(parsedError);

    return {
      message: error.message,
      stack: error.stack,
      matcherResult: !!error.matcherResult,
      mappedErrors,
    };
  }

  getDescribeBlocks(test: TestEntry) {
    let t: ?(TestEntry | DescribeBlock) = test;
    const blocks = [];

    // $FlowIssue
    while (t.parent != null) {
      blocks.push(t.parent.name);
      // $FlowIssue
      t = t.parent;
    }

    // Remove ROOT_DESCRIBE_BLOCK
    blocks.pop();

    return blocks.reverse();
  }

  async testToCodeSandbox(test: TestEntry) {
    const [path, name] = test.name.split(':#:');

    const errors = await Promise.all(test.errors.map(this.errorToCodeSandbox));

    return {
      name,
      path,
      duration: test.duration,
      status: test.status || 'running',
      errors,
      blocks: this.getDescribeBlocks(test),
    };
  }

  handleMessage = async (message: Event) => {
    switch (message.name) {
      case 'test_start': {
        const test = await this.testToCodeSandbox(message.test);
        return this.sendMessage('test_start', {
          test,
        });
      }
      case 'test_failure':
      case 'test_success': {
        const { suppressedErrors } = expect.getState();

        if (suppressedErrors && suppressedErrors.length) {
          /* eslint-disable no-param-reassign */
          message.test.errors = suppressedErrors;
          message.test.status = 'fail';
          /* eslint-enable no-param-reassign */
          expect.setState({ suppressedErrors: [] });
        }
        const test = await this.testToCodeSandbox(message.test);

        if (test.errors) {
          test.errors.forEach(err => {
            if (err.mappedErrors) {
              const { mappedErrors } = err;
              const mappedError = mappedErrors[0];

              dispatch(
                actions.error.show(err.name || 'Jest Error', err.message, {
                  line: mappedError._originalLineNumber,
                  column: mappedError._originalColumnNumber,
                  path: test.path,
                  payload: {},
                })
              );
            }
          });
        }
        try {
          return this.sendMessage('test_end', {
            test,
          });
        } catch (e) {
          const error = await this.errorToCodeSandbox(e);
          return this.sendMessage('file_error', { path: test.path, error });
        }
      }
      case 'start_describe_definition': {
        return this.sendMessage('describe_start', {
          blockName: message.blockName,
        });
      }
      case 'finish_describe_definition': {
        return this.sendMessage('describe_end');
      }
      case 'add_test': {
        const [path, testName] = message.testName.split(':#:');
        return this.sendMessage('add_test', {
          testName,
          path,
        });
      }
      default: {
        return null;
      }
    }
  };

  handleCodeSandboxMessage = (message: any) => {
    if (message) {
      if (message.type === 'set-test-watching') {
        this.watching = message.watching;
        if (message.watching === true) {
          this.ranTests.clear();
          this.runTests(true);
        }
      } else if (message.type === 'run-all-tests') {
        this.ranTests.clear();
        this.runTests(true);
      } else if (message.type === 'run-tests') {
        const path = message.path;

        this.ranTests.delete(path);
        this.runTests();
      }
    }
  };
}
