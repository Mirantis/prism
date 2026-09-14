/**
 * The object a plugin page imports.
 *
 * A plugin's page is built by the runtime with `@prism/plugin` resolved to a
 * global, so the page runs on this app's React, renders this app's components
 * and shares its query client. Two copies of React in one document break hooks,
 * and a `<Card>` that is not the one the rest of the UI renders would not match
 * the product.
 *
 * A single default export, so adding a component here needs no change on the
 * runtime side — the esbuild shim re-exports this whole object and enumerates
 * nothing. Installed once, before the router renders.
 */

import * as React from 'react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Alert, AlertTitle, AlertDescription, AlertAction } from '@/components/ui/alert';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Field, FieldLabel, FieldDescription, FieldError, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

import { Grid } from '@/components/plugin-ui/grid';
import { Icon } from '@/components/plugin-ui/icon';
import { PageHeader } from '@/components/plugin-ui/page-header';
import { Row } from '@/components/plugin-ui/row';
import { Section } from '@/components/plugin-ui/section';
import { Stack } from '@/components/plugin-ui/stack';

import { pluginApi } from './plugin-api';

/** The name the runtime's esbuild shim reads. Both sides must agree on it. */
export const HOST_GLOBAL = '__PRISM_PLUGIN_HOST__';

/** What a plugin page's `ui` holds. */
const ui = {
  // Layout — what a page reaches for first, since it cannot write a class.
  Stack,
  Row,
  Grid,
  Section,
  PageHeader,

  Alert,
  AlertTitle,
  AlertDescription,
  AlertAction,
  Avatar,
  AvatarImage,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
  CardFooter,
  Checkbox,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Separator,
  Skeleton,
  Switch,
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Textarea,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} as const;

/** Everything a page gets that does not depend on which plugin it is. */
const shared = {
  // The JSX transform's own entry point, kept apart from the rest because the
  // runtime shim re-exports these names directly.
  jsxRuntime: { jsx, jsxs, jsxDEV: jsx, Fragment },

  // React, by the names a page uses.
  useState: React.useState,
  useEffect: React.useEffect,
  useMemo: React.useMemo,
  useCallback: React.useCallback,
  useRef: React.useRef,
  useReducer: React.useReducer,
  useId: React.useId,
  Fragment: React.Fragment,
  createElement: React.createElement,

  useQuery,
  useMutation,
  useQueryClient,

  Icon,
  ui,
} as const;

export type PluginHost = typeof shared & {
  api: ReturnType<typeof pluginApi>;
};

/**
 * The host object as a page sees it. `api` is bound to that page's own plugin,
 * so a page cannot address another plugin's routes through it.
 *
 * A page asks for its own host by id rather than reading whichever one was
 * installed last: the runtime writes the id into the built module at build
 * time, so a page's identity does not depend on load order.
 */
function forPlugin(pluginId: string): PluginHost {
  return { ...shared, api: pluginApi(pluginId) };
}

export interface PluginHostGlobal {
  jsxRuntime: typeof shared.jsxRuntime;
  forPlugin(pluginId: string): PluginHost;
}

declare global {
  interface Window {
    __PRISM_PLUGIN_HOST__?: PluginHostGlobal;
  }
}

/**
 * Put the host where a plugin module looks for it. Called once, before the
 * router renders, so any page the SPA imports finds it.
 */
export function installPluginHost(): void {
  window.__PRISM_PLUGIN_HOST__ = { jsxRuntime: shared.jsxRuntime, forPlugin };
}
