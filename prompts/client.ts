/**
 * Who the agent says it is calling from.
 *
 * Fixed rather than configured. The name came from CALL_PROMPT_CLIENT_NAME and
 * the city from CALL_PROMPT_CLIENT_CITY, set separately on every server, so
 * what a donor heard depended on which server placed the call.
 */
const CLIENT_NAME = 'Apna Blood Bank';
const CLIENT_CITY = 'Palwal';
const CLIENT_WITH_CITY = `${CLIENT_NAME}, ${CLIENT_CITY}`;

module.exports = { CLIENT_NAME, CLIENT_CITY, CLIENT_WITH_CITY };
