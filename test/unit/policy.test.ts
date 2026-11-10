import { describe, expect, it } from 'vitest';
import { blockReason, parameterRefusal, scriptBlockReason } from '../../src/policy.js';

describe('blockReason', () => {
  it('allows normal image processing', () => {
    expect(blockReason('PixelMath', ['PixelMath'])).toBeNull();
    expect(blockReason('StarAlignment', ['ImageRegistration', 'Preprocessing'])).toBeNull();
    expect(blockReason('NewImage', ['Image', 'Global'], true)).toBeNull();
  });

  it.each(['Preferences', 'Script', 'ProcessContainer', 'NetworkService', 'FilterManager'])('blocks %s', (id) => {
    expect(blockReason(id, [])).toEqual(expect.any(String));
  });

  it('blocks anything that controls equipment, by category', () => {
    expect(blockReason('IndigoMount', ['Instrumentation'])).toMatch(/equipment/);
  });

  it('allows RGBWorkingSpace on an image, but not as a program-wide setting', () => {
    expect(blockReason('RGBWorkingSpace', ['ColorSpaces'])).toBeNull();
    expect(blockReason('RGBWorkingSpace', ['ColorSpaces'], true)).toMatch(/default RGB working space/);
  });
});

describe('parameters that change what a process does or talks to', () => {
  const rules = { allowedPrograms: [], allowOverwrite: true };
  const gaia = [{ id: 'command', default: 'search' }, { id: 'magnitudeHigh', default: 12 }];
  const pcc = [{ id: 'serverURL', default: 'https://vizier.example/' }];

  it('keeps a command at its default', () => {
    expect(parameterRefusal('Gaia', gaia, { command: 'configure' }, rules)).toMatch(/has to stay at its default/);
    expect(parameterRefusal('Gaia', gaia, { command: 'search', magnitudeHigh: 14 }, rules)).toBeNull();
    expect(parameterRefusal('Gaia', gaia, {}, rules)).toBeNull();
  });

  it('keeps the address of a server at its default', () => {
    expect(parameterRefusal('PhotometricColorCalibration', pcc, { serverURL: 'https://elsewhere.example/' }, rules)).toMatch(/which server it talks to/);
    expect(parameterRefusal('PhotometricColorCalibration', pcc, { serverURL: 'https://vizier.example/' }, rules)).toBeNull();
  });
});

describe('parameterRefusal', () => {
  const rules = { allowedPrograms: ['/opt/graxpert/GraXpert'], allowOverwrite: false };
  const overwriting = [{ id: 'overwriteExistingFiles', default: false }, { id: 'other', default: 1 }];

  it('lets ordinary settings through', () => {
    expect(parameterRefusal('P', overwriting, { other: 2 }, rules)).toBeNull();
  });

  describe('external programs', () => {
    const graxpert = [{ id: 'appPath', default: '' }];

    it('refuses a program the user has not allowed', () => {
      expect(parameterRefusal('GraXpert', graxpert, { appPath: '/bin/sh' }, rules)).toMatch(/PIXINSIGHT_MCP_ALLOWED_PROGRAMS/);
    });

    it('accepts a program the user has allowed', () => {
      expect(parameterRefusal('GraXpert', graxpert, { appPath: '/opt/graxpert/GraXpert' }, rules)).toBeNull();
    });

    it('leaves the setting of the process alone if nothing is passed', () => {
      expect(parameterRefusal('GraXpert', graxpert, {}, rules)).toBeNull();
    });

    it('recognizes other spellings', () => {
      expect(parameterRefusal('Other', [{ id: 'Executable' }], { Executable: '/bin/sh' }, rules)).toEqual(expect.any(String));
    });
  });

  describe('replacing files', () => {
    it('refuses overwriting unless the request accepts it', () => {
      expect(parameterRefusal('ImageCalibration', overwriting, { overwriteExistingFiles: true }, rules)).toMatch(/cannot be undone/);
      expect(parameterRefusal('ImageCalibration', overwriting, { overwriteExistingFiles: true }, { ...rules, allowOverwrite: true })).toBeNull();
    });

    it('allows turning it off', () => {
      expect(parameterRefusal('CometAlignment', [{ id: 'overwrite', default: true }], { overwrite: false }, rules)).toBeNull();
    });

    it('takes anything but a plain false for a yes', () => {
      for (const value of [1, 'true', 'yes', null]) {
        expect(parameterRefusal('ImageCalibration', overwriting, { overwriteExistingFiles: value }, rules)).toEqual(expect.any(String));
      }
      expect(parameterRefusal('ImageCalibration', overwriting, { overwriteExistingFiles: false }, rules)).toBeNull();
    });

    it('also catches a process that overwrites by default', () => {
      expect(parameterRefusal('CometAlignment', [{ id: 'overwrite', default: true }], {}, rules)).toMatch(/overwrite is true/);
    });
  });
});

describe('scriptBlockReason', () => {
  it('allows the scripts people process images with', () => {
    expect(scriptBlockReason(['Astrometry > ImageSolver'])).toBeNull();
    expect(scriptBlockReason(['Batch Processing > WeightedBatchPreprocessing', 'Utilities > Other'])).toBeNull();
  });

  it('blocks scripts for equipment and for developers, whichever of their menus says so', () => {
    expect(scriptBlockReason(['Instrumentation > MountControl'])).toMatch(/equipment/);
    expect(scriptBlockReason(['Utilities > Keys', 'Development > Keys'])).toMatch(/developer tools/);
    expect(scriptBlockReason(['Development>Keys'])).toMatch(/developer tools/);
  });

  it('does not depend on how a script spells the menu', () => {
    expect(scriptBlockReason(['instrumentation > x'])).toMatch(/equipment/);
    expect(scriptBlockReason(['  DEVELOPMENT>x'])).toMatch(/developer/);
  });

  it('finds nothing for a menu that only carries the name of something every object has', () => {
    expect(scriptBlockReason(['constructor > x', 'toString > y', '__proto__ > z'])).toBeNull();
    expect(blockReason('constructor', ['toString'])).toBeNull();
  });

  it('goes by the menu, not by a word in the name', () => {
    expect(scriptBlockReason(['Utilities > Development of a mosaic'])).toBeNull();
  });
});
