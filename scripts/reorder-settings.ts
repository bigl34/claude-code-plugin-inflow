
export type ReorderSource =
  | "reorderSettings"
  | "multipleLocations"
  | "legacyFlatField"
  | "none";

export interface NormalizedReorderSetting {
  locationId: string | null;
  locationName: string | null;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  reorderMethod: string | null;
  enableReordering: boolean;
}

export interface ReorderThresholds {
  reorderPoint: number | null;
  reorderQuantity: number | null;
  reorderSource: ReorderSource;
  reorderSettings: NormalizedReorderSetting[] | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function quantityOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function normalizeSetting(raw: unknown): NormalizedReorderSetting {
  const setting = asRecord(raw);
  const location = asRecord(setting.location);
  return {
    locationId: optionalString(setting.locationId) ?? optionalString(location.locationId),
    locationName: optionalString(location.name),
    reorderPoint: quantityOrNull(setting.reorderPoint),
    reorderQuantity: quantityOrNull(setting.reorderQuantity),
    reorderMethod: optionalString(setting.reorderMethod),
    enableReordering: setting.enableReordering === true,
  };
}

export function readReorderThresholds(rawProduct: unknown): ReorderThresholds {
  const product = asRecord(rawProduct);

  const legacyPoint = quantityOrNull(product.reorderPoint);
  const legacyQuantity = quantityOrNull(product.reorderQuantity);

  const rawSettings = product.reorderSettings;
  const settings = Array.isArray(rawSettings) ? rawSettings.map(normalizeSetting) : null;

  const enabled = (settings ?? []).filter((setting) => setting.enableReordering);

  if (enabled.length === 1) {
    return {
      reorderPoint: enabled[0].reorderPoint,
      reorderQuantity: enabled[0].reorderQuantity,
      reorderSource: "reorderSettings",
      reorderSettings: settings,
    };
  }

  if (enabled.length > 1) {
    return {
      reorderPoint: null,
      reorderQuantity: null,
      reorderSource: "multipleLocations",
      reorderSettings: settings,
    };
  }

  const hasLegacyValue = legacyPoint !== null || legacyQuantity !== null;
  return {
    reorderPoint: legacyPoint,
    reorderQuantity: legacyQuantity,
    reorderSource: hasLegacyValue ? "legacyFlatField" : "none",
    reorderSettings: settings,
  };
}
