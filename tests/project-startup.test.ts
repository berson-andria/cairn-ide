import assert from 'node:assert/strict';
import test from 'node:test';
import { selectStartupFolder } from '../src/app/shared/models/project-startup.model.ts';

test('startup prefers a launch folder over the saved last project', () => {
  assert.equal(
    selectStartupFolder(
      { folder: 'launch-folder', newWindow: false },
      'last-project',
      true,
      true,
    ),
    'launch-folder',
  );
});

test('startup restores the last project unless this is a new window', () => {
  assert.equal(
    selectStartupFolder({ newWindow: false }, 'last-project', false, true),
    'last-project',
  );
  assert.equal(selectStartupFolder({ newWindow: true }, 'last-project', false, true), null);
});

test('startup stays empty when its selected folder is missing', () => {
  assert.equal(
    selectStartupFolder(
      { folder: 'missing-launch-folder', newWindow: false },
      'valid-last-project',
      false,
      true,
    ),
    null,
  );
  assert.equal(selectStartupFolder({ newWindow: false }, 'missing-last-project', false, false), null);
});
