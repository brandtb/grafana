import { DataFrame, FieldConfigSource, FieldType } from '@grafana/data';
import { SeriesVisibilityChangeMode } from '@grafana/ui';

import { isHideSeriesOverride, seriesVisibilityConfigFactory } from './SeriesVisibilityConfigFactory';

function makeFrame(fields: Array<{ name: string; type: FieldType }>): DataFrame {
  return {
    name: 'test',
    length: 1,
    fields: fields.map((f) => ({ name: f.name, type: f.type, config: {}, values: [] })),
  };
}

const emptyConfig: FieldConfigSource = { defaults: {}, overrides: [] };

// Mixed data: two numeric, one boolean, one enum
const data: DataFrame[] = [
  makeFrame([
    { name: 'Number1', type: FieldType.number },
    { name: 'Number2', type: FieldType.number },
    { name: 'Bool1', type: FieldType.boolean },
    { name: 'Enum1', type: FieldType.enum },
  ]),
];

// Data that also contains non-plottable string and time fields
const dataWithNonPlottable: DataFrame[] = [
  makeFrame([
    { name: 'Time1', type: FieldType.time },
    { name: 'Label1', type: FieldType.string },
    { name: 'Number1', type: FieldType.number },
    { name: 'Number2', type: FieldType.number },
  ]),
];

describe('seriesVisibilityConfigFactory', () => {
  describe('ToggleSelection (single-click isolation)', () => {
    it('shows only the clicked series and hides boolean/enum fields', () => {
      const result = seriesVisibilityConfigFactory(
        'Number1',
        SeriesVisibilityChangeMode.ToggleSelection,
        emptyConfig,
        data
      );

      const override = result.overrides.find(isHideSeriesOverride);
      expect(override).toBeDefined();

      // "names" is the shown list; fields NOT in names are hidden
      const names: string[] = override!.matcher.options.names;
      expect(names).toContain('Number1'); // isolated series is shown
      expect(names).not.toContain('Number2');
      expect(names).not.toContain('Bool1');
      expect(names).not.toContain('Enum1');
    });
  });

  describe('AppendToSelection (Ctrl-click to add/remove from isolation group)', () => {
    it('does not remove the override when Ctrl-clicking all numeric fields if boolean/enum exist', () => {
      // Single-click Number1 to start isolation: names = [Number1]
      const afterToggle = seriesVisibilityConfigFactory(
        'Number1',
        SeriesVisibilityChangeMode.ToggleSelection,
        emptyConfig,
        data
      );

      // Ctrl-click Number2 to add it to the shown group: names = [Number1, Number2]
      const afterCtrl = seriesVisibilityConfigFactory(
        'Number2',
        SeriesVisibilityChangeMode.AppendToSelection,
        afterToggle,
        data
      );

      // Bug (before fix): allFieldsAreExcluded counted only numeric fields (2), so
      // names.length (2) === total (2) → override removed → Bool1/Enum1 reappeared.
      // After fix: total includes boolean + enum (4), so 2 !== 4 → override kept.
      const override = afterCtrl.overrides.find(isHideSeriesOverride);
      expect(override).toBeDefined();

      const names: string[] = override!.matcher.options.names;
      expect(names).toContain('Number1');
      expect(names).toContain('Number2');
      expect(names).not.toContain('Bool1'); // still hidden
      expect(names).not.toContain('Enum1'); // still hidden
    });

    it('removes the override only after all plottable fields (including boolean and enum) are shown', () => {
      // Isolate Number1
      const s1 = seriesVisibilityConfigFactory(
        'Number1',
        SeriesVisibilityChangeMode.ToggleSelection,
        emptyConfig,
        data
      );
      // Add Number2, Bool1, Enum1 back one by one
      const s2 = seriesVisibilityConfigFactory('Number2', SeriesVisibilityChangeMode.AppendToSelection, s1, data);
      const s3 = seriesVisibilityConfigFactory('Bool1', SeriesVisibilityChangeMode.AppendToSelection, s2, data);
      const s4 = seriesVisibilityConfigFactory('Enum1', SeriesVisibilityChangeMode.AppendToSelection, s3, data);

      // All four plottable fields now in the "shown" list → override should be removed
      expect(s4.overrides.find(isHideSeriesOverride)).toBeUndefined();
    });
  });

  describe('string and time fields are not treated as plottable', () => {
    it('does not include string or time fields in the isolation shown-list', () => {
      const result = seriesVisibilityConfigFactory(
        'Number1',
        SeriesVisibilityChangeMode.ToggleSelection,
        emptyConfig,
        dataWithNonPlottable
      );

      const names: string[] = result.overrides.find(isHideSeriesOverride)!.matcher.options.names;
      expect(names).toContain('Number1');
      expect(names).not.toContain('Time1');
      expect(names).not.toContain('Label1');
    });

    it('removes the override when all numeric fields (the only plottable ones) are shown, ignoring string and time', () => {
      // Isolate Number1 then add Number2 back — with only 2 plottable fields this should
      // trigger allFieldsAreExcluded and remove the override.
      const s1 = seriesVisibilityConfigFactory(
        'Number1',
        SeriesVisibilityChangeMode.ToggleSelection,
        emptyConfig,
        dataWithNonPlottable
      );
      const s2 = seriesVisibilityConfigFactory(
        'Number2',
        SeriesVisibilityChangeMode.AppendToSelection,
        s1,
        dataWithNonPlottable
      );

      expect(s2.overrides.find(isHideSeriesOverride)).toBeUndefined();
    });
  });
});
