'use strict';

const { types: utilTypes } = require('node:util');

const INVALID_RETAINED_VALUE = Symbol('invalid-retained-value');

function valueSafeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function ownDataDescriptors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    return null;
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (_error) {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') return null;
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value')) return null;
  }
  return descriptors;
}

function canonicalizeHydratedInsertOptions(options, {
  unsafeCode,
  unsafeMessage,
  leanCode,
  leanMessage
}) {
  if (options == null) return;
  const descriptors = ownDataDescriptors(options);
  if (!descriptors) throw valueSafeError(unsafeCode, unsafeMessage);

  const leanDescriptor = descriptors.lean;
  if (leanDescriptor?.value) throw valueSafeError(leanCode, leanMessage);
  if (!leanDescriptor && !Object.isExtensible(options)) {
    throw valueSafeError(unsafeCode, unsafeMessage);
  }
  if (leanDescriptor && leanDescriptor.configurable === false && leanDescriptor.writable === false) return;
  try {
    Object.defineProperty(options, 'lean', {
      configurable: false,
      enumerable: leanDescriptor?.enumerable === true,
      value: false,
      writable: false
    });
  } catch (_error) {
    throw valueSafeError(unsafeCode, unsafeMessage);
  }
}

function dataEntries(value) {
  const descriptors = ownDataDescriptors(value);
  if (!descriptors) return null;
  return Object.keys(descriptors).map((key) => [key, descriptors[key].value]);
}

function dataArrayValues(value) {
  if (!Array.isArray(value) || utilTypes.isProxy(value)) return null;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (_error) {
    return null;
  }
  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    values.push(descriptor.value);
  }
  return values;
}

function normalizeBoundedString(value, {
  maxLength = 128,
  pattern = null,
  trim = true
} = {}) {
  if (typeof value !== 'string') return INVALID_RETAINED_VALUE;
  const normalized = trim ? value.trim() : value;
  if (!normalized || normalized.length > maxLength) return INVALID_RETAINED_VALUE;
  if (pattern && !pattern.test(normalized)) return INVALID_RETAINED_VALUE;
  return normalized;
}

function normalizeNullableBoundedString(value, options) {
  if (value == null) return null;
  return normalizeBoundedString(value, options);
}

function normalizeEnum(value, allowedValues, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  return typeof value === 'string' && allowedValues.has(value)
    ? value
    : INVALID_RETAINED_VALUE;
}

function normalizeNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : INVALID_RETAINED_VALUE;
}

function normalizeNullableDate(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
      return INVALID_RETAINED_VALUE;
    }
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? INVALID_RETAINED_VALUE : new Date(timestamp);
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) return INVALID_RETAINED_VALUE;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (_error) {
    return INVALID_RETAINED_VALUE;
  }
  if (prototype !== Date.prototype) return INVALID_RETAINED_VALUE;
  const timestamp = Date.prototype.getTime.call(value);
  return Number.isNaN(timestamp) ? INVALID_RETAINED_VALUE : new Date(timestamp);
}

function normalizeNullableObjectId(value, ObjectId) {
  if (value == null) return null;
  if (typeof value === 'string') {
    return /^[a-f0-9]{24}$/i.test(value) ? new ObjectId(value) : INVALID_RETAINED_VALUE;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) return INVALID_RETAINED_VALUE;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (_error) {
    return INVALID_RETAINED_VALUE;
  }
  return prototype === ObjectId.prototype ? value : INVALID_RETAINED_VALUE;
}

function isInvalidRetainedValue(value) {
  return value === INVALID_RETAINED_VALUE;
}

module.exports = {
  INVALID_RETAINED_VALUE,
  canonicalizeHydratedInsertOptions,
  dataArrayValues,
  dataEntries,
  isInvalidRetainedValue,
  normalizeBoundedString,
  normalizeEnum,
  normalizeNonNegativeInteger,
  normalizeNullableBoundedString,
  normalizeNullableDate,
  normalizeNullableObjectId,
  ownDataDescriptors,
  valueSafeError
};
