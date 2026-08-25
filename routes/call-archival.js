'use strict';

const express = require('express');
const Call = require('../src/models/Call');
const { createMongooseArchiveHandlers } = require('../src/webmaster/lifecycle');

function createCallArchiveRouter({ CallModel = Call } = {}) {
  const router = express.Router();
  const handlers = createMongooseArchiveHandlers({ Model: CallModel, resourceName: 'Call' });

  router.post('/bulk/archive', handlers.archiveBulk);
  router.delete('/bulk', handlers.archiveBulk);
  router.post('/bulk/restore', handlers.restoreBulk);
  return router;
}

module.exports = createCallArchiveRouter();
module.exports.createCallArchiveRouter = createCallArchiveRouter;
