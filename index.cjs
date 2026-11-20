'use strict';

const inspector = require('./lib/inspector.cjs');
const oracle = require('./lib/winlator-oracle.cjs');
const scaffolder = require('./lib/scaffolder.cjs');
const logDoctor = require('./lib/log-doctor.cjs');
const store = require('./lib/store.cjs');
const web = require('./lib/web.cjs');
const installers = require('./lib/installers.cjs');

module.exports = {
  ...inspector,
  ...oracle,
  ...scaffolder,
  ...logDoctor,
  ...store,
  ...web,
  ...installers
};
