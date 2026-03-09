import { PluginConfig } from '../config/types';
import { OpenClawApprovalsPlugin } from '../plugin';
import { OpenClawRuntimeApprovalEventSource, OpenClawEventBusLike } from '../adapters/openclaw-event-source';
import { OpenClawApprovalsApiLike, OpenClawRuntimeResolverAdapter } from '../adapters/openclaw-resolver';

export interface OpenClawRuntimeLike {
  events: OpenClawEventBusLike;
  approvals: OpenClawApprovalsApiLike;
}

export function bindOpenClawRuntime(params: {
  runtime: OpenClawRuntimeLike;
  config: PluginConfig;
  callbackUrl: string;
}): OpenClawApprovalsPlugin {
  const resolver = new OpenClawRuntimeResolverAdapter(params.runtime.approvals);
  const source = new OpenClawRuntimeApprovalEventSource(params.runtime.events);
  const plugin = new OpenClawApprovalsPlugin(params.config, resolver);
  plugin.bindApprovalRequested(source, params.callbackUrl);
  return plugin;
}
