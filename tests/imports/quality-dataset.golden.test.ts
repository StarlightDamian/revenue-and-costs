import { describe, expect, it } from "vitest";
import { createDatasetVersionManifest } from "../../src/modules/datasets";
import { evaluateSliceQuality, validateQualityAcknowledgement } from "../../src/modules/quality";

describe("数据版本与完整性 Golden", () => {
  it("季度交易与月度配送通过显式覆盖形成月切片，不比较文件数或行数", () => {
    const version = createDatasetVersionManifest({
      id: "version-1",
      sliceId: "slice-2026-01",
      shopId: "shop-1",
      marketplace: "amazon.de",
      localMonth: "2026-01",
      sources: [
        { reportKind: "TRANSACTION", importFileIds: ["quarter-file"], mappingVersionId: "tx-v1", coverageStart: "2026-01-01", coverageEnd: "2026-03-31" },
        { reportKind: "SHIPMENT", importFileIds: ["january-file"], mappingVersionId: "ship-v1", coverageStart: "2026-01-01", coverageEnd: "2026-01-31" },
      ],
    });
    expect(version.status).toBe("READY");
  });

  it("缺少整类报告是硬不完整，不能因为确认排除而变为可纳入", () => {
    const result = evaluateSliceQuality({
      shipment: "PRESENT",
      transaction: "MISSING",
      mappingConfirmed: true,
      coverageComplete: true,
      sourcesConflict: false,
      fxAvailable: true,
    }, { comparable: false });
    expect(result.hardReasons).toEqual(["MISSING_TRANSACTION_REPORT"]);
    expect(result.publishDisposition).toBe("BLOCK");
  });

  it("两侧完整时任意非零数量差仅产生软警告", () => {
    const result = evaluateSliceQuality({
      shipment: "PRESENT",
      transaction: "PRESENT",
      mappingConfirmed: true,
      coverageComplete: true,
      sourcesConflict: false,
      fxAvailable: true,
    }, { comparable: true, shipmentQuantity: "10", transactionQuantity: "9", intersectionQuantity: "9" });
    expect(result.hardReasons).toEqual([]);
    expect(result.reconciliation).toMatchObject({ warning: true, unmatchedAbsolute: "1.00000000" });
    expect(result.publishDisposition).toBe("INCLUDE");
  });

  it("未知站点按大站点要求原因和二次确认", () => {
    expect(() => validateQualityAcknowledgement({
      kind: "SOFT_RECONCILIATION_WARNING",
      marketplaceSize: "UNKNOWN",
      reason: "已与结算时点差异核对",
      confirmations: "1",
    })).toThrow("QUALITY_ACK_SECOND_CONFIRMATION_REQUIRED");
    expect(() => validateQualityAcknowledgement({
      kind: "SOFT_RECONCILIATION_WARNING",
      marketplaceSize: "UNKNOWN",
      reason: "已与结算时点差异核对",
      confirmations: "2",
    })).not.toThrow();
  });
});
