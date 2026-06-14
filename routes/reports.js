const express = require('express');
const router = express.Router();

/*
 * Reports page disabled.
 *
 * The report preview/download/email endpoints that powered public/reports.html
 * were removed from runtime per request. Keep exporting an empty router so any
 * accidental import remains harmless.
 */

module.exports = router;
