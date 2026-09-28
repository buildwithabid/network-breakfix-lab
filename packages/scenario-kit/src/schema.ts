import { z } from "zod";

const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
const IPV4_RE = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`);
const CIDR_RE = new RegExp(`^${OCTET}(\\.${OCTET}){3}/(3[0-2]|[12]?[0-9])$`);

export const Ipv4 = z.string().regex(IPV4_RE, "must be an IPv4 address");
export const Cidr = z
  .string()
  .regex(CIDR_RE, "must be an IPv4 prefix like 10.0.1.0/24")
  .refine(isNetworkAddress, "must be the network address of the prefix (host bits zero)");
export const NodeName = z.string().regex(/^[a-z][a-z0-9]{0,14}$/, "node names are lowercase, max 15 chars");
const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase words joined by '-'");

export const RouteProtocol = z.enum(["connected", "static", "ospf", "bgp", "kernel", "local"]);

/** Checker rules. Each one maps to one read-only command on one node (see checker/rules.ts). */
export const Rule = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("reachability"),
      from: NodeName.describe("a host"),
      to: Ipv4,
      count: z.number().int().min(1).max(10).default(3),
    })
    .strict(),
  z
    .object({
      type: z.literal("route-present"),
      router: NodeName,
      prefix: Cidr,
      protocol: RouteProtocol,
      nexthop: Ipv4.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ospf-neighbor"),
      router: NodeName,
      neighbor: Ipv4.describe("the neighbour's OSPF router ID"),
      state: z.enum(["Full", "2-Way"]).default("Full"),
    })
    .strict(),
  z
    .object({
      type: z.literal("bgp-session"),
      router: NodeName,
      peer: Ipv4,
      state: z.literal("Established").default("Established"),
    })
    .strict(),
  z
    .object({
      type: z.literal("prefix-received"),
      router: NodeName,
      peer: Ipv4,
      prefix: Cidr,
    })
    .strict(),
]);
export type Rule = z.infer<typeof Rule>;

export const Objective = z
  .object({
    id: Slug,
    description: z.string().min(5).max(200),
    rule: Rule,
    /** Pass when the rule does NOT hold, e.g. a prefix that must stay filtered. */
    negate: z.boolean().default(false),
  })
  .strict();
export type Objective = z.infer<typeof Objective>;

export const ScenarioMeta = z
  .object({
    id: z.string().regex(/^[0-9]{2}-[a-z0-9]+(-[a-z0-9]+)*$/, "ids look like 01-wrong-ip-mask"),
    title: z.string().min(3).max(80),
    difficulty: z.enum(["easy", "medium", "hard"]),
    timeLimitMinutes: z.number().int().min(5).max(120),
    ticket: z.string().min(20).max(2000),
    objectives: z.array(Objective).min(1).max(12),
    hints: z.array(z.string().min(3).max(300)).max(8).default([]),
  })
  .strict();
export type ScenarioMeta = z.infer<typeof ScenarioMeta>;

/** The subset of a containerlab topology a scenario may use. The renderer adds binds and caps. */
export const ScenarioTopology = z
  .object({
    name: z.string(),
    topology: z
      .object({
        nodes: z.record(
          NodeName,
          z
            .object({
              kind: z.literal("linux"),
              image: z.string(),
              exec: z.array(z.string()).optional(),
            })
            .strict(),
        ),
        links: z.array(
          z
            .object({
              endpoints: z.tuple([
                z.string().regex(/^[a-z][a-z0-9]{0,14}:eth([1-9]|[12][0-9]|3[0-2])$/),
                z.string().regex(/^[a-z][a-z0-9]{0,14}:eth([1-9]|[12][0-9]|3[0-2])$/),
              ]),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();
export type ScenarioTopology = z.infer<typeof ScenarioTopology>;

export function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

function isNetworkAddress(cidr: string): boolean {
  const [ip = "", len = "0"] = cidr.split("/");
  const bits = Number(len);
  const hostBits = 32 - bits;
  return hostBits === 32 ? ipToInt(ip) === 0 : ipToInt(ip) % 2 ** hostBits === 0;
}
