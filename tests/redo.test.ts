import { expect, test } from 'claude-code/testing'

import { isRedo } from '../hooks/redo'

const PROMPT =
  'Implement the signin signout and settings pages in the web app, then add tests covering each route and run the suite'

test('the same task sent again is a redo, retry words or not', () => {
  const first = { description: 'T3 signin, signout, settings', prompt: PROMPT }
  expect(isRedo(first, first)).toBe(true)
  expect(isRedo(first, { description: 'T3 signin, signout, settings (retry)', prompt: PROMPT })).toBe(true)
  expect(isRedo(first, { description: 'Redo: T3 signin, signout, settings', prompt: `${PROMPT} carefully` })).toBe(true)
})

test('a templated batch is not a redo, however alike its prompts', () => {
  const body = 'Audit the findings listed below against the source and report which ones hold up with evidence for each'
  expect(
    isRedo(
      { description: 'Audit R+RT findings', prompt: `${body} group R` },
      { description: 'Audit T+B findings', prompt: `${body} group T` },
    ),
  ).toBe(false)
})

test('the same name on different work is not a redo', () => {
  expect(
    isRedo(
      { description: 'Build parser', prompt: PROMPT },
      {
        description: 'Build parser',
        prompt: 'Write a tokenizer for the config language using recursive descent with useful error messages and line numbers',
      },
    ),
  ).toBe(false)
})

test('too little text to compare is not a redo', () => {
  expect(isRedo({ description: 'Fix it', prompt: 'Fix the test' }, { description: 'Fix it', prompt: 'Fix the test' })).toBe(false)
  expect(isRedo({ description: '', prompt: PROMPT }, { description: '', prompt: PROMPT })).toBe(false)
  // A name made only of retry words names nothing.
  expect(isRedo({ description: 'retry', prompt: PROMPT }, { description: 'again', prompt: PROMPT })).toBe(false)
})
