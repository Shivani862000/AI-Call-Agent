'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildThreeMonthFollowupPrompt,
  buildThreeMonthFollowupOpeningPrompt
} = require('../prompts/three-month-followup.ts');
const {
  buildThreeMonthFollowupTurnInstruction,
  buildReviewCallTurnInstruction
} = require('../src/conversation-state');
const { detectReportedDonation, detectRedonationInterest } = require('../services/call-analysis');

const spokenPartOnly = (prompt) => String(prompt).split(/^Rules:/m)[0];

function everySpokenLine() {
  const donated = { step: 'intro', lastVisitDate: '2026-05-15' };
  const first = buildThreeMonthFollowupTurnInstruction('haan ji', donated, 'Apna Blood Centre', 'Rajesh');
  const second = buildThreeMonthFollowupTurnInstruction('haan, kiya tha', donated, 'Apna Blood Centre', 'Rajesh');
  const third = buildThreeMonthFollowupTurnInstruction('pichle mahine', donated, 'Apna Blood Centre', 'Rajesh');
  const fourth = buildThreeMonthFollowupTurnInstruction('Delhi mein', donated, 'Apna Blood Centre', 'Rajesh');

  const notDonated = { step: 'intro', lastVisitDate: '2026-05-15' };
  buildThreeMonthFollowupTurnInstruction('haan ji', notDonated, 'Apna Blood Centre', 'Rajesh');
  const asked = buildThreeMonthFollowupTurnInstruction('nahi', notDonated, 'Apna Blood Centre', 'Rajesh');
  const accepted = buildThreeMonthFollowupTurnInstruction('haan zaroor', { ...notDonated }, 'Apna Blood Centre', 'Rajesh');

  return [
    spokenPartOnly(buildThreeMonthFollowupPrompt({ donorName: 'Rajesh', lastVisitDate: '2026-05-15' })),
    buildThreeMonthFollowupOpeningPrompt({ donorName: 'Rajesh' }),
    first, second, third, fourth, asked, accepted,
    buildThreeMonthFollowupTurnInstruction('galat number', { step: 'intro' }, 'Apna Blood Centre', 'Rajesh')
  ];
}

test('the follow-up call never assumes the donor is male', () => {
  for (const line of everySpokenLine()) {
    assert.equal(/\bsir\b|\bmadam\b|\bmaam\b/i.test(line), false, `gendered address in:\n${line}`);
  }
});

// The default used to be the literal string "Donor", so a donor with no name on
// file was asked "Kya main Donor ji se baat kar rahi hoon?"
test('an unknown donor is not addressed as the word Donor', () => {
  const opening = buildThreeMonthFollowupOpeningPrompt({});
  assert.doesNotMatch(opening, /Donor ji/);
  assert.match(opening, /Kya main aapse do minute baat kar sakti hoon/);
});

test('the opening discloses that the call is automated and recorded', () => {
  const opening = buildThreeMonthFollowupOpeningPrompt({ donorName: 'Rajesh' });
  assert.match(opening, /automated call/i);
  assert.match(opening, /record ho rahi hai/i);
});

// The city was hardcoded into a line that otherwise used the client name.
test('the city travels with the client name', () => {
  assert.match(buildThreeMonthFollowupOpeningPrompt({ donorName: 'R' }), /Apna Blood Centre, Palwal se/);
  assert.match(
    buildThreeMonthFollowupOpeningPrompt({ clientName: 'City Blood Bank', clientCity: 'Jaipur', donorName: 'R' }),
    /City Blood Bank, Jaipur se/
  );
  assert.doesNotMatch(buildThreeMonthFollowupOpeningPrompt({ clientCity: '', donorName: 'R' }), /Palwal/);
});

// Whoever picked up may not be the donor, and that they gave blood is health data.
test('nothing about the donation is said before identity is confirmed', () => {
  const opening = buildThreeMonthFollowupOpeningPrompt({ donorName: 'Rajesh' });
  assert.doesNotMatch(opening, /donate|blood donation|3 mahine/i);

  const wrongNumber = buildThreeMonthFollowupTurnInstruction('galat number', { step: 'intro' }, 'Apna Blood Centre', 'Rajesh');
  assert.doesNotMatch(wrongNumber, /donate/i);
  assert.doesNotMatch(wrongNumber, /Rajesh/);
});

test('the review call also confirms identity before mentioning the donation', () => {
  const wrongNumber = buildReviewCallTurnInstruction('galat number', { step: 'intro' }, 'Client', 'Ankita');
  assert.doesNotMatch(wrongNumber, /Ankita/);
  assert.match(wrongNumber, /Koi baat nahi/);
});

// "galat number" carries no "nahi" and no busy word, so neither existing
// classifier caught it: the call read a wrong number as a confirmed identity
// and told a stranger this person had donated blood.
test('a wrong number is recognised on both call types', () => {
  for (const reply of ['galat number', 'wrong number', 'ye kaun bol raha hai', 'main nahi hoon', 'koi aur hai']) {
    const review = buildReviewCallTurnInstruction(reply, { step: 'intro' }, 'Client', 'Ankita');
    assert.doesNotMatch(review, /donate/i, `review call disclosed the donation to: ${reply}`);
    assert.doesNotMatch(review, /Ankita/, `review call named the patient to: ${reply}`);

    const followUp = buildThreeMonthFollowupTurnInstruction(reply, { step: 'intro' }, 'Apna Blood Centre', 'Rajesh');
    assert.doesNotMatch(followUp, /donate/i, `follow-up disclosed the donation to: ${reply}`);
    assert.doesNotMatch(followUp, /Rajesh/, `follow-up named the donor to: ${reply}`);
  }
});

test('a genuine confirmation is not mistaken for a wrong number', () => {
  const confirmed = buildReviewCallTurnInstruction('haan ji main hi hoon', { step: 'intro' }, 'Client', 'Ankita');
  assert.match(confirmed, /Identity confirmed/);
});

test('future-donation interest is recorded in the same field the review call uses', () => {
  const yes = { step: 'plan_to_donate' };
  buildThreeMonthFollowupTurnInstruction('haan zaroor', yes, 'Apna Blood Centre', 'Rajesh');
  assert.equal(yes.redonationInterest, 'yes');

  const no = { step: 'plan_to_donate' };
  buildThreeMonthFollowupTurnInstruction('nahi, interested nahi', no, 'Apna Blood Centre', 'Rajesh');
  assert.equal(no.redonationInterest, 'no');

  const unsure = { step: 'plan_to_donate' };
  buildThreeMonthFollowupTurnInstruction('pata nahi, dekhta hoon', unsure, 'Apna Blood Centre', 'Rajesh');
  assert.equal(unsure.redonationInterest, 'unclear');
});

// The review call asks every donor about booking; the follow-up asked only
// whether they were interested, so a willing donor was never offered a slot.
test('a willing donor is asked to book a slot', () => {
  const state = { step: 'intro', lastVisitDate: '2026-05-15' };
  buildThreeMonthFollowupTurnInstruction('haan ji', state, 'Apna Blood Centre', 'Rajesh');
  buildThreeMonthFollowupTurnInstruction('nahi', state, 'Apna Blood Centre', 'Rajesh');

  const offer = buildThreeMonthFollowupTurnInstruction('haan zaroor', state, 'Apna Blood Centre', 'Rajesh');
  assert.match(offer, /slot book karna chahenge/);
  assert.equal(state.step, 'appointment');

  const booked = buildThreeMonthFollowupTurnInstruction('haan, book kar dijiye', state, 'Apna Blood Centre', 'Rajesh');
  assert.match(booked, /Hamari team aapko call karke slot confirm kar degi/);
  assert.equal(state.redonationInterest, 'yes');
  assert.equal(state.conversationState, 'COMPLETED');
});

test('a donor who has already donated again is asked about the next one', () => {
  const state = { step: 'intro', lastVisitDate: '2026-05-15' };
  buildThreeMonthFollowupTurnInstruction('haan ji', state, 'Apna Blood Centre', 'Rajesh');
  buildThreeMonthFollowupTurnInstruction('haan kiya tha', state, 'Apna Blood Centre', 'Rajesh');
  buildThreeMonthFollowupTurnInstruction('pichle mahine', state, 'Apna Blood Centre', 'Rajesh');

  const offer = buildThreeMonthFollowupTurnInstruction('Delhi mein', state, 'Apna Blood Centre', 'Rajesh');
  assert.match(offer, /slot book karna chahenge/);
  assert.equal(state.reportedDonationDate, 'pichle mahine');
  assert.equal(state.reportedDonationPlace, 'Delhi mein');
});

// Pushing a booking on someone who just declined is how a service call becomes
// a nuisance call.
test('a donor who says they are not interested is not asked to book', () => {
  const state = { step: 'intro', lastVisitDate: '2026-05-15' };
  buildThreeMonthFollowupTurnInstruction('haan ji', state, 'Apna Blood Centre', 'Rajesh');
  buildThreeMonthFollowupTurnInstruction('nahi', state, 'Apna Blood Centre', 'Rajesh');

  const declined = buildThreeMonthFollowupTurnInstruction('nahi, interested nahi', state, 'Apna Blood Centre', 'Rajesh');
  assert.doesNotMatch(declined, /slot book karna chahenge/);
  assert.equal(state.redonationInterest, 'no');
  assert.equal(state.conversationState, 'COMPLETED');
});

// Willing to donate but not ready to pick a date is still a lead worth keeping.
test('declining the slot does not erase a stated willingness to donate', () => {
  const state = { step: 'plan_to_donate' };
  buildThreeMonthFollowupTurnInstruction('haan zaroor', state, 'Apna Blood Centre', 'Rajesh');
  assert.equal(state.redonationInterest, 'yes');

  buildThreeMonthFollowupTurnInstruction('abhi nahi', state, 'Apna Blood Centre', 'Rajesh');
  assert.equal(state.redonationInterest, 'yes');
});

test('a reported donation date and place are lifted out of the transcript', () => {
  const turns = [
    { role: 'AI', text: 'Bahut achha. Kab donate kiya tha?' },
    { role: 'PATIENT', text: 'pichle mahine' },
    { role: 'AI', text: 'Kahan donate kiya tha?' },
    { role: 'PATIENT', text: 'Delhi mein ek camp tha' }
  ];
  assert.deepEqual(detectReportedDonation(turns), { date: 'pichle mahine', place: 'Delhi mein ek camp tha' });
  assert.deepEqual(detectReportedDonation([]), { date: '', place: '' });
});

test('the follow-up interest question feeds the appointment field', () => {
  const turns = [
    { role: 'AI', text: 'Kya aap bhavishya mein blood donate karne mein ruchi rakhte hain?' },
    { role: 'PATIENT', text: 'haan zaroor' }
  ];
  assert.equal(detectRedonationInterest(turns).interest, 'yes');
});
