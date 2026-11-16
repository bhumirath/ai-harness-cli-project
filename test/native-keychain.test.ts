import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'linux')(
  'fails closed when Linux Secret Service is unavailable',
  () => {
    const source = `
    import { writeKeychainToken } from ${JSON.stringify(new URL('../src/keychain.ts', import.meta.url).href)};
    try {
      writeKeychainToken('harness-test-unavailable', 'hk_dummy_test');
      process.exitCode = 1;
    } catch (error) {
      if (error.exitCode !== 3 || error.message.includes('hk_dummy_test')) process.exitCode = 1;
      else console.log('safe failure');
    }
  `
    const output = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', source],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=/tmp/harness-no-keychain-${process.pid}`,
        },
      },
    )
    expect(output.trim()).toBe('safe failure')
  },
)
