function clean(value) {
  if (Array.isArray(value)) return value[0] ?? null;
  if (value === undefined || value === null || value === "") return null;
  return String(value).trim();
}

export function buildSizeMap(sizeRow) {
  if (!sizeRow) return null;

  const f = sizeRow.fields;

  return {
    euSize: clean(f["EU Size"]),
    usSize: clean(f["US Size"]),
    usWomensSize: clean(f["US Women's Size"]),
    usGsSize: clean(f["US GS Size"]),
    usPsSize: clean(f["US PS Size"]),
    usTdSize: clean(f["US TD Size"])
  };
}
