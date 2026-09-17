/** Independent qualitative creativity cases; the original stock case set is untouched. */
import {readFileSync} from "node:fs";
import type {StockCase} from "./stock-cases.ts";
export function loadCreativeSuite():{schemaVersion:number;id:string;version:string;scope:string;review:string;cases:StockCase[]}{
 const suite=JSON.parse(readFileSync(new URL("./creative-cases.json",import.meta.url),"utf8"));
 if(suite.cases.length<4||suite.cases.length>6||new Set(suite.cases.map((c:StockCase)=>c.id)).size!==suite.cases.length)throw new Error("Creative probe must contain4–6 distinct cases");
 for(const c of suite.cases){if(c.track!=="creative"||c.split!=="development"||!c.id.startsWith("creative.")||!c.rubric.length||!c.steps.length||c.steps.some((s:any)=>s.action!=="send"||typeof s.text!=="string"))throw new Error("Invalid creative scenario");}
 return suite;
}
