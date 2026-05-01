export function buildSizeMap(sizeRow) {
  if (!sizeRow) return null;

  const f = sizeRow.fields;

  return {
    euSize: f["EU Size"],
    usSize: f["US Size"],
    usWomensSize: f["US Women's Size"],
    usGsSize: f["US GS Size"],
    usPsSize: f["US PS Size"],
    usTdSize: f["US TD Size"]
  };
}
