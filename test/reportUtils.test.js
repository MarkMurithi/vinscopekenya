import test from 'node:test';
import assert from 'node:assert/strict';
import { filterSavedReports, buildComparisonChartData, buildVehicleHistorySections } from '../src/utils/reportUtils.js';

test('filterSavedReports matches text across report fields', () => {
  const reports = [
    { vin: 'ABC123', make: 'Toyota', model: 'Prado', year: 2017, score: 88 },
    { vin: 'XYZ999', make: 'Honda', model: 'Accord', year: 2020, score: 74 },
  ];

  const filtered = filterSavedReports(reports, 'honda');

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].vin, 'XYZ999');
});

test('buildComparisonChartData returns score-based chart rows', () => {
  const reports = [
    { vin: 'ABC123', make: 'Toyota', model: 'Prado', score: 88 },
    { vin: 'XYZ999', make: 'Honda', model: 'Accord', score: 40 },
  ];

  const chartRows = buildComparisonChartData(reports);

  assert.equal(chartRows.length, 2);
  assert.equal(chartRows[0].score, 88);
  assert.equal(chartRows[1].rating, 'risk');
});

test('buildVehicleHistorySections creates detail cards for each history category', () => {
  const report = {
    theft: 'No record',
    ownership: 'Single owner',
    accidents: 'No major accidents',
    mileage: 'Mileage appears consistent',
    score: 91,
  };

  const sections = buildVehicleHistorySections(report);

  assert.equal(sections.length, 5);
  assert.equal(sections[0].title, 'Theft history');
  assert.equal(sections[2].value, 'No major accidents');
  assert.equal(sections[4].value, '91/100');
});
