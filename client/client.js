window.__ModuleLoader__.load({
	id: "workspace-organizer-dsh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const zod = require("zod");
		const h = React.createElement;

		/* ------------------------------------------------------------------ *
		 * Remote contribution: the browser half of the `workspaceOrganizer`
		 * namespace. Descriptors carry strict input codecs, as the Gateway's
		 * client contribution validator requires. Results are decoded as
		 * opaque JSON because the Host face is in source mode.
		 * ------------------------------------------------------------------ */

		const PACKAGE = "workspace-organizer-dsh";
		const NAMESPACE = "workspaceOrganizer";

		const anyResult = {
			mode: "strict",
			typeSymbol: `${PACKAGE}#result`,
			create: () => zod.any(),
			jsonSchema: {}
		};

		function jsonCodec(name, create, jsonSchema) {
			return {
				mode: "strict",
				typeSymbol: `${PACKAGE}#${name}`,
				create,
				jsonSchema
			};
		}

		function direct(method, parameters, description) {
			return {
				id: `${PACKAGE}#${NAMESPACE}/${method}`,
				service: "workspaceOrganizerRemote",
				namespace: NAMESPACE,
				method,
				description,
				invocation: { kind: "direct" },
				parameters,
				result: anyResult
			};
		}

		const requestCodec = (name, properties) => jsonCodec(
			name,
			() => zod.object(properties),
			{
				type: "object",
				properties: Object.fromEntries(Object.keys(properties).map((key) => [key, { type: "string" }])),
				required: Object.keys(properties),
				additionalProperties: false
			}
		);

		const contribution = {
			package: PACKAGE,
			descriptors: [
				direct("status", [], "Capability and dependency report."),
				direct("snapshot", [], "Current logical organization tree."),
				direct("rows", [], "Depth-first tree rows."),
				direct("createProject", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("CreateProjectRequest", {
						parentId: zod.string(),
						title: zod.string()
					})
				}], "Create one nested Project."),
				direct("renameNode", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("RenameNodeRequest", {
						id: zod.string(),
						title: zod.string()
					})
				}], "Rename one logical node."),
				direct("moveNode", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("MoveNodeRequest", {
						id: zod.string(),
						parentId: zod.string()
					})
				}], "Move one logical node under another Project."),
				direct("createConversation", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("CreateConversationRequest", {
						parentId: zod.string(),
						title: zod.string()
					})
				}], "Create an ordinary conversation; refused while the host binds a directory."),
				direct("registerWorkspace", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("RegisterWorkspaceRequest", {
						parentId: zod.string(),
						title: zod.string(),
						directory: zod.string()
					})
				}], "Register a terminal Workspace over an existing directory."),
				direct("bindDirectoryConversation", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("BindDirectoryConversationRequest", {
						workspaceId: zod.string(),
						title: zod.string(),
						sessionId: zod.string()
					})
				}], "Bind an existing directory-bound Conversation."),
				direct("linkExistingSession", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("LinkExistingSessionRequest", {
						projectId: zod.string(),
						title: zod.string(),
						sessionId: zod.string()
					})
				}], "Link a host-verified existing Session to a logical Project folder; never creates or moves a Session."),
				direct("conversationTarget", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("ConversationTargetRequest", {
						conversationId: zod.string()
					})
				}], "Resolve a Conversation to its current native Session target (read-only)."),
				direct("reconcileTasks", [{
					name: "request",
					wire: "request",
					source: "json",
					codec: requestCodec("ReconcileTasksRequest", {
						conversationId: zod.string()
					})
				}], "Reconcile the official catalog into the task ledger (read-only)."),
				direct("taskLedger", [], "Read-only task ledger snapshot.")
			]
		};

		/* ------------------------------------------------------------------ *
		 * Small view helpers
		 * ------------------------------------------------------------------ */

		/** Generated Remote calls answer with `{ ok, value }`; unwrap or throw. */
		function unwrap(answer) {
			if (answer !== null && typeof answer === "object" && "ok" in answer) {
				if (answer.ok !== true) {
					const error = answer.error ?? {};
					const failure = new Error(error.message ?? "workspace organizer request failed");
					failure.code = error.code;
					failure.details = error.details;
					throw failure;
				}
				return answer.value;
			}
			return answer;
		}

		/** Failure text a user can read; `code` is kept for the row title. */
		function failureText(error) {
			const code = error && error.code !== undefined ? `${String(error.code)}: ` : "";
			const message = error instanceof Error ? error.message : String(error);
			return `${code}${message}`;
		}

		function buildRows(nodes) {
			const byParent = new Map();
			for (const node of nodes) {
				const key = node.parentId === null ? "__root__" : node.parentId;
				const list = byParent.get(key) ?? [];
				list.push(node);
				byParent.set(key, list);
			}
			const roots = nodes.filter((node) => node.parentId === null);
			const visited = new Set();
			const build = (node, depth) => {
				if (visited.has(node.id)) return [];
				visited.add(node.id);
				const children = byParent.get(node.id) ?? [];
				return [{
					node,
					depth,
					children: children.flatMap((child) => build(child, depth + 1))
				}];
			};
			return roots.flatMap((root) => build(root, 0));
		}

		/* ------------------------------------------------------------------ *
		 * Component: replaces the `sidebar.workspaces` browsing region only.
		 * Native shell, conversation panel, and right column are untouched.
		 * ------------------------------------------------------------------ */

		function OrganizerBrowser() {
			const remote = useRemote();
			const [snapshot, setSnapshot] = React.useState(null);
			const snapshotRef = React.useRef(null);
			snapshotRef.current = snapshot;
			const [status, setStatus] = React.useState(null);
			const statusRef = React.useRef(null);
			statusRef.current = status;
			const [selected, setSelected] = React.useState(null);
			const selectedRef = React.useRef(null);
			selectedRef.current = selected;
			const [title, setTitle] = React.useState("");
			const titleRef = React.useRef("");
			titleRef.current = title;
			const [directory, setDirectory] = React.useState("");
			const [sessionId, setSessionId] = React.useState("");
			const [linked, setLinked] = React.useState(function () { return new Set(); });
			const [linkStatus, setLinkStatus] = React.useState("");
			const [moveMode, setMoveMode] = React.useState(true);
			const [movePreview, setMovePreview] = React.useState(null);
			const [moveError, setMoveError] = React.useState("");
			const [moveSubmitting, setMoveSubmitting] = React.useState(false);
			const moveSubmittingRef = React.useRef(false);
			moveSubmittingRef.current = moveSubmitting;
			const moveRequest = React.useRef(0);
			const movePreviewRef = React.useRef(null);
			movePreviewRef.current = movePreview;
			const movePreviewToken = React.useRef(0);
			const [renameTarget, setRenameTarget] = React.useState(null);
			const [renameDraft, setRenameDraft] = React.useState("");
			const [renameError, setRenameError] = React.useState("");
			const [renameSubmitting, setRenameSubmitting] = React.useState(false);
			const renameSubmittingRef = React.useRef(false);
			const renameRequest = React.useRef(0);
			const renameDraftRef = React.useRef("");
			renameDraftRef.current = renameDraft;
			const renameToken = React.useRef(0);
			const renameTargetRef = React.useRef(null);
			renameTargetRef.current = renameTarget;
			const [createProjectActive, setCreateProjectActive] = React.useState(false);
			const [createProjectParent, setCreateProjectParent] = React.useState(null);
			const [createProjectDraft, setCreateProjectDraft] = React.useState("");
			const [createProjectError, setCreateProjectError] = React.useState("");
			const [createProjectSubmitting, setCreateProjectSubmitting] = React.useState(false);
			const [createProjectUnconfirmed, setCreateProjectUnconfirmed] = React.useState(false);
			const createProjectSubmittingRef = React.useRef(false);
			createProjectSubmittingRef.current = createProjectSubmitting;
			const createProjectRequest = React.useRef(0);
			const createProjectParentRef = React.useRef(null);
			createProjectParentRef.current = createProjectParent;
			const createProjectDraftRef = React.useRef("");
			createProjectDraftRef.current = createProjectDraft;
			const createProjectToken = React.useRef(0);
			const createProjectUnconfirmedRef = React.useRef(false);
			createProjectUnconfirmedRef.current = createProjectUnconfirmed;
			const [linkWorkspaceActive, setLinkWorkspaceActive] = React.useState(false);
			const [linkWorkspaceParent, setLinkWorkspaceParent] = React.useState(null);
			const [linkWorkspaceDraftTitle, setLinkWorkspaceDraftTitle] = React.useState("");
			const [linkWorkspaceDraftDirectory, setLinkWorkspaceDraftDirectory] = React.useState("");
			const [linkWorkspaceError, setLinkWorkspaceError] = React.useState("");
			const [linkWorkspaceSubmitting, setLinkWorkspaceSubmitting] = React.useState(false);
			const [linkWorkspaceUnconfirmed, setLinkWorkspaceUnconfirmed] = React.useState(false);
			const linkWorkspaceSubmittingRef = React.useRef(false);
			linkWorkspaceSubmittingRef.current = linkWorkspaceSubmitting;
			const linkWorkspaceRequest = React.useRef(0);
			const linkWorkspaceParentRef = React.useRef(null);
			linkWorkspaceParentRef.current = linkWorkspaceParent;
			const linkWorkspaceDraftTitleRef = React.useRef("");
			linkWorkspaceDraftTitleRef.current = linkWorkspaceDraftTitle;
			const linkWorkspaceDraftDirectoryRef = React.useRef("");
			linkWorkspaceDraftDirectoryRef.current = linkWorkspaceDraftDirectory;
			const linkWorkspaceToken = React.useRef(0);
			const linkWorkspaceUnconfirmedRef = React.useRef(false);
			linkWorkspaceUnconfirmedRef.current = linkWorkspaceUnconfirmed;
			const [linkSessionActive, setLinkSessionActive] = React.useState(false);
			const [linkSessionWorkspace, setLinkSessionWorkspace] = React.useState(null);
			const [linkSessionDraftTitle, setLinkSessionDraftTitle] = React.useState("");
			const [linkSessionDraftSessionId, setLinkSessionDraftSessionId] = React.useState("");
			const [linkSessionError, setLinkSessionError] = React.useState("");
			const [linkSessionSubmitting, setLinkSessionSubmitting] = React.useState(false);
			const [linkSessionUnconfirmed, setLinkSessionUnconfirmed] = React.useState(false);
			const linkSessionSubmittingRef = React.useRef(false);
			linkSessionSubmittingRef.current = linkSessionSubmitting;
			const linkSessionRequest = React.useRef(0);
			const linkSessionWorkspaceRef = React.useRef(null);
			linkSessionWorkspaceRef.current = linkSessionWorkspace;
			const linkSessionDraftTitleRef = React.useRef("");
			linkSessionDraftTitleRef.current = linkSessionDraftTitle;
			const linkSessionDraftSessionIdRef = React.useRef("");
			linkSessionDraftSessionIdRef.current = linkSessionDraftSessionId;
			const linkSessionToken = React.useRef(0);
			const linkSessionUnconfirmedRef = React.useRef(false);
			linkSessionUnconfirmedRef.current = linkSessionUnconfirmed;
			const [projectSessionLinkActive, setProjectSessionLinkActive] = React.useState(false);
			const [projectSessionLinkTarget, setProjectSessionLinkTarget] = React.useState(null);
			const [projectSessionLinkTitle, setProjectSessionLinkTitle] = React.useState("");
			const [projectSessionLinkId, setProjectSessionLinkId] = React.useState("");
			const [projectSessionLinkError, setProjectSessionLinkError] = React.useState("");
			const [projectSessionLinkSubmitting, setProjectSessionLinkSubmitting] = React.useState(false);
			const [projectSessionLinkUnconfirmed, setProjectSessionLinkUnconfirmed] = React.useState(false);
			const projectSessionLinkSubmittingRef = React.useRef(false);
			projectSessionLinkSubmittingRef.current = projectSessionLinkSubmitting;
			const projectSessionLinkRequest = React.useRef(0);
			const projectSessionLinkToken = React.useRef(0);
			const projectSessionLinkTargetRef = React.useRef(null);
			projectSessionLinkTargetRef.current = projectSessionLinkTarget;
			const projectSessionLinkTitleRef = React.useRef("");
			projectSessionLinkTitleRef.current = projectSessionLinkTitle;
			const projectSessionLinkIdRef = React.useRef("");
			projectSessionLinkIdRef.current = projectSessionLinkId;
			const projectSessionLinkUnconfirmedRef = React.useRef(false);
			projectSessionLinkUnconfirmedRef.current = projectSessionLinkUnconfirmed;
			const taskSourceRef = React.useRef(null);
			const taskLedgerRef = React.useRef(null);
			const refreshRequest = React.useRef(0);
			const isMountedRef = React.useRef(true);
			const [taskSource, setTaskSource] = React.useState(null);
			taskSourceRef.current = taskSource;
			const [taskLedger, setTaskLedger] = React.useState(null);
			taskLedgerRef.current = taskLedger;
			const [taskStatus, setTaskStatus] = React.useState("idle");
			const taskStatusRef = React.useRef("idle");
			taskStatusRef.current = taskStatus;
			const [taskError, setTaskError] = React.useState("");
			const taskToken = React.useRef(0);
			const taskRequest = React.useRef(0);
			const [findScope, setFindScope] = React.useState(null);
			const [findQuery, setFindQuery] = React.useState("");
			const [findDescendants, setFindDescendants] = React.useState(true);
			const [findLocated, setFindLocated] = React.useState("");
			const findToken = React.useRef(0);
			const findScopeRef = React.useRef(null);
			const findQueryRef = React.useRef("");
			const findDescendantsRef = React.useRef(true);
			const findQueryVersion = React.useRef(0);
			const [taskCenterOpen, setTaskCenterOpen] = React.useState(false);
			const taskCenterOpenRef = React.useRef(false);
			taskCenterOpenRef.current = taskCenterOpen;
			const [taskCenterLedger, setTaskCenterLedger] = React.useState(null);
			const taskCenterLedgerRef = React.useRef(null);
			taskCenterLedgerRef.current = taskCenterLedger;
			const [taskCenterStatus, setTaskCenterStatus] = React.useState("idle");
			const taskCenterStatusRef = React.useRef("idle");
			taskCenterStatusRef.current = taskCenterStatus;
			const [taskCenterError, setTaskCenterError] = React.useState("");
			const [taskCenterSelected, setTaskCenterSelected] = React.useState(null);
			const taskCenterSelectedRef = React.useRef(null);
			taskCenterSelectedRef.current = taskCenterSelected;
			const [taskCenterLocateNotice, setTaskCenterLocateNotice] = React.useState("");
			const [taskCenterLocateState, setTaskCenterLocateState] = React.useState("idle");
			const [taskCenterSourceFilter, setTaskCenterSourceFilter] = React.useState("");
			const taskCenterSourceFilterRef = React.useRef("");
			taskCenterSourceFilterRef.current = taskCenterSourceFilter;
			const taskCenterToken = React.useRef(0);
			const taskCenterRelationViewLifetime = React.useRef(0);
			const taskCenterRequest = React.useRef(0);
			const locateRequest = React.useRef(0);
			const locateTimer = React.useRef(null);
			const [notice, setNotice] = React.useState("");
			const [snapshotStale, setSnapshotStale] = React.useState(false);
			const snapshotStaleRef = React.useRef(false);
			snapshotStaleRef.current = snapshotStale;
			const [busy, setBusy] = React.useState(false);
			const [collapsed, setCollapsed] = React.useState(function () { return new Set(); });
			const [visibleSections, setVisibleSections] = React.useState(function () {
				return new Set(["quick-access", "projects", "recent"]);
			});
			const [quickAccessCollapsed, setQuickAccessCollapsed] = React.useState(false);
			const [quickAccessItems, setQuickAccessItems] = React.useState(function () { return []; });
			const quickAccessItemsRef = React.useRef([]);
			quickAccessItemsRef.current = quickAccessItems;
			const quickAccessTokensRef = React.useRef(new Map());
			const quickAccessTokenSeqRef = React.useRef(0);
			const [quickAccessTasks, setQuickAccessTasks] = React.useState(function () { return []; });
			const quickAccessTasksRef = React.useRef([]);
			quickAccessTasksRef.current = quickAccessTasks;
			const taskMembershipTokensRef = React.useRef(new Map());
			const taskMembershipSeqRef = React.useRef(0);
			const taskPinIntentRef = React.useRef(new Map());
			const [projectsCollapsed, setProjectsCollapsed] = React.useState(false);
			const [recentCollapsed, setRecentCollapsed] = React.useState(false);
			const [createPanelOpen, setCreatePanelOpen] = React.useState(false);
			const [liteMenuNode, setLiteMenuNode] = React.useState(null);

			const hideSection = (section) => {
				if (section !== "quick-access" && section !== "projects" && section !== "recent") return;
				setVisibleSections(function (previous) {
					const next = new Set(previous);
					next.delete(section);
					return next;
				});
			};

			const restoreSection = (section) => {
				if (section !== "quick-access" && section !== "projects" && section !== "recent") return;
				setVisibleSections(function (previous) {
					const next = new Set(previous);
					next.add(section);
					return next;
				});
			};

			const restoreAllSections = () => {
				setVisibleSections(new Set(["quick-access", "projects", "recent"]));
			};

			const toggleProject = (id) => {
				setCollapsed(function (previous) {
					const next = new Set(previous);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
			};

			const refresh = React.useCallback(async () => {
				if (!isMountedRef.current) return;
				if (renameSubmittingRef.current || moveSubmittingRef.current || createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current || projectSessionLinkSubmittingRef.current) {
					return;
				}

				const generation = refreshRequest.current + 1;
				refreshRequest.current = generation;

				let pSnap;
				let pStat;
				try {
					pSnap = Promise.resolve(remote.snapshot()).then(unwrap);
					pStat = Promise.resolve(remote.status()).then(unwrap);
					pSnap.catch(() => {});
					pStat.catch(() => {});
				} catch (syncErr) {
					if (!isMountedRef.current || refreshRequest.current !== generation) {
						return;
					}
					setSnapshotStale(true);
					setNotice(failureText(syncErr));
					return;
				}

				try {
					const [next, reported] = await Promise.all([pSnap, pStat]);
					if (!isMountedRef.current || refreshRequest.current !== generation) {
						return;
					}
					setSnapshot(next);
					setStatus(reported);
					setSnapshotStale(false);
					setNotice("");
					setQuickAccessItems(function (previous) {
						if (previous.length === 0) return previous;
						const existingIds = new Set(next && Array.isArray(next.nodes) ? next.nodes.map((node) => node.id) : []);
						const filtered = previous.filter((id) => {
							if (!existingIds.has(id)) {
								quickAccessTokensRef.current.delete(id);
								return false;
							}
							return true;
						});
						return filtered.length === previous.length ? previous : filtered;
					});
				} catch (error) {
					if (!isMountedRef.current || refreshRequest.current !== generation) {
						return;
					}
					setSnapshotStale(true);
					setNotice(failureText(error));
				}
			}, [remote]);

			React.useEffect(() => {
				refresh();
			}, [refresh]);

			React.useEffect(() => {
				return () => {
					isMountedRef.current = false;
					taskCenterToken.current += 1;
					taskCenterRelationViewLifetime.current += 1;
					taskCenterOpenRef.current = false;
					quickAccessTokensRef.current.clear();
					taskMembershipTokensRef.current.clear();
					taskPinIntentRef.current.clear();
					taskToken.current += 1;
					taskSourceRef.current = null;
					taskRequest.current += 1;
					refreshRequest.current += 1;
					locateRequest.current += 1;
					if (locateTimer.current !== null) {
						clearTimeout(locateTimer.current);
						locateTimer.current = null;
					}
					findToken.current += 1;
					findScopeRef.current = null;
					findQueryVersion.current += 1;
					renameToken.current += 1;
					renameTargetRef.current = null;
					renameRequest.current += 1;
					movePreviewToken.current += 1;
					movePreviewRef.current = null;
					moveRequest.current += 1;
					createProjectToken.current += 1;
					createProjectParentRef.current = null;
					createProjectUnconfirmedRef.current = false;
					createProjectRequest.current += 1;
					linkWorkspaceToken.current += 1;
					linkWorkspaceParentRef.current = null;
					linkWorkspaceUnconfirmedRef.current = false;
					linkWorkspaceRequest.current += 1;
					linkSessionToken.current += 1;
					linkSessionWorkspaceRef.current = null;
					linkSessionUnconfirmedRef.current = false;
					linkSessionRequest.current += 1;
					projectSessionLinkToken.current += 1;
					projectSessionLinkTargetRef.current = null;
					projectSessionLinkUnconfirmedRef.current = false;
					projectSessionLinkRequest.current += 1;
					taskCenterRequest.current += 1;
				};
			}, []);

			const run = async (action) => {
				refreshRequest.current += 1;
				setBusy(true);
				setNotice("");
				try {
					await action();
					await refresh();
				} catch (error) {
					setNotice(failureText(error));
				} finally {
					setBusy(false);
				}
			};

			const selectedNode = snapshot === null
				? undefined
				: snapshot.nodes.find((node) => node.id === selected);
			const parentId = selectedNode === undefined
				? (snapshot === null ? undefined : snapshot.rootId)
				: (selectedNode.kind === "project" ? selectedNode.id : undefined);
			const canCreate = parentId !== undefined && (selectedNode === undefined || selectedNode.kind === "project");
			const isDescendantOf = (node, ancestorId, treeSnapshot) => {
				const currentSnapshot = treeSnapshot !== undefined ? treeSnapshot : (snapshotRef.current !== null ? snapshotRef.current : snapshot);
				let cursor = node;
				const visited = new Set();
				while (cursor !== undefined && cursor.parentId !== null) {
					if (visited.has(cursor.id)) return false;
					visited.add(cursor.id);
					if (cursor.parentId === ancestorId) return true;
					cursor = currentSnapshot === null ? undefined : currentSnapshot.nodes.find((entry) => entry.id === cursor.parentId);
				}
				return false;
			};
			const isMovableConversation = selectedNode !== undefined &&
				selectedNode.kind === "conversation" &&
				typeof selectedNode.sessionId === "string" && selectedNode.sessionId.trim().length > 0 &&
				selectedNode.cwd === undefined &&
				selectedNode.parentId !== null &&
				snapshot !== null &&
				snapshot.nodes.some((n) => n.id === selectedNode.parentId && n.kind === "project");
			const canMove = selectedNode !== undefined && (
				((selectedNode.kind === "project" || selectedNode.kind === "workspace") &&
					selectedNode.parentId !== null &&
					(snapshot === null || selectedNode.id !== snapshot.rootId)) ||
				isMovableConversation
			);
			const moveTargets = canMove && snapshot !== null
				? snapshot.nodes.filter((node) => node.kind === "project" &&
					(selectedNode.kind === "workspace" || selectedNode.kind === "conversation" || (node.id !== selectedNode.id && !isDescendantOf(node, selectedNode.id))))
				: [];

			const validateAncestorChain = (node, currentSnapshot) => {
				if (node === undefined || node === null || currentSnapshot === null) return false;
				const visited = new Set();
				let cursor = node;
				let depth = 0;
				while (cursor !== undefined && cursor.parentId !== null) {
					if (visited.has(cursor.id)) return false;
					visited.add(cursor.id);
					depth += 1;
					if (depth > 100) return false;
					cursor = currentSnapshot.nodes.find((entry) => entry.id === cursor.parentId);
					if (cursor === undefined) return false;
				}
				return true;
			};

			const cancelMove = (context) => {
				if (!isMountedRef.current) return;
				if (moveSubmittingRef.current) return;
				if (context !== undefined && context !== null) {
					if (context.token !== movePreviewToken.current) return;
					if (context.sourceId !== undefined && context.sourceId !== null) {
						if (movePreviewRef.current === null ||
							movePreviewRef.current.sourceId !== context.sourceId ||
							movePreviewRef.current.targetId !== context.targetId ||
							movePreviewRef.current.token !== context.token) {
							return;
						}
					} else if (movePreviewRef.current !== null) {
						return;
					}
				}
				movePreviewToken.current += 1;
				movePreviewRef.current = null;
				moveRequest.current += 1;
				setMovePreview(null);
				setMoveError("");
				setNotice("");
				setMoveMode(false);
			};

			const previewMove = (targetId, expectedSourceId) => {
				if (!isMountedRef.current) return;
				if (moveSubmittingRef.current || createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current) return;

				const sourceNode = selectedNode;
				if (sourceNode === undefined || sourceNode === null) return;
				if (expectedSourceId !== undefined && expectedSourceId !== null) {
					if (sourceNode.id !== expectedSourceId || selectedRef.current !== expectedSourceId) return;
				}

				if (createProjectActive) {
					const msg = "正在创建项目中，请先完成或取消创建 / Project creation in progress; please finish or cancel first";
					setMoveError(msg);
					setNotice(msg);
					return;
				}

				if (linkWorkspaceActive) {
					const msg = "正在关联工作区中，请先完成或取消关联 / Workspace linking in progress; please finish or cancel first";
					setMoveError(msg);
					setNotice(msg);
					return;
				}

				if (linkSessionActive) {
					const msg = "正在关联会话中，请先完成或取消关联 / Session linking in progress; please finish or cancel first";
					setMoveError(msg);
					setNotice(msg);
					return;
				}

				if (renameSubmittingRef.current || renameTarget !== null) {
					const msg = "正在重命名中，请先保存或取消重命名 / Rename in progress; please finish or cancel first";
					setMoveError(msg);
					setNotice(msg);
					return;
				}

				if (snapshot === null) {
					setMoveError("快照未就绪，无法移动 / Snapshot is not available");
					return;
				}
				if (snapshotStale) {
					setMoveError("快照已陈旧失效，拒绝操作 / Snapshot is stale; move refused");
					return;
				}

				if (sourceNode.parentId === null || (sourceNode.kind === "project" && sourceNode.id === snapshot.rootId)) {
					setMoveError("根项目禁止移动 / Root project cannot be moved");
					return;
				}
				if (sourceNode.kind !== "project" && sourceNode.kind !== "workspace" && sourceNode.kind !== "conversation") {
					setMoveError("仅支持移动项目、工作区或普通会话 / Only projects, workspaces, and conversations can be moved");
					return;
				}
				if (!snapshot.nodes.some((n) => n.id === sourceNode.id)) {
					setMoveError("源节点在快照中不存在 / Source node not found in snapshot");
					return;
				}
				if (sourceNode.kind === "conversation") {
					if (typeof sourceNode.sessionId !== "string" || sourceNode.sessionId.trim().length === 0) {
						setMoveError("会话Session缺失或无效，无法移动 / Session ID missing or invalid; move refused");
						return;
					}
					if (sourceNode.cwd !== undefined) {
						setMoveError("目录绑定会话禁止移动到项目 / Conversation has directory binding (cwd); move refused");
						return;
					}
					const parentNode = snapshot.nodes.find((n) => n.id === sourceNode.parentId);
					if (parentNode === undefined || parentNode.kind !== "project") {
						setMoveError("当前会话归属于工作区而非项目，禁止移动 / Conversation is under workspace; move refused");
						return;
					}
					if (snapshot.nodes.filter((n) => n.id === sourceNode.id).length !== 1) {
						setMoveError("会话在快照中存在重复，无法移动 / Conversation identity is duplicated in snapshot");
						return;
					}
				}

				const isRootTarget = targetId === "root" || (snapshot.rootId !== undefined && targetId === snapshot.rootId);
				const resolvedTargetId = isRootTarget ? (snapshot.rootId || "root") : targetId;

				let targetNode = snapshot.nodes.find((n) => n.id === resolvedTargetId);
				if (targetNode === undefined) {
					if (isRootTarget && sourceNode.kind !== "conversation") {
						targetNode = {
							id: snapshot.rootId || "root",
							kind: "project",
							title: "Root",
							parentId: null
						};
					} else {
						setMoveError("目标节点在快照中不存在 / Target node not found in snapshot");
						return;
					}
				}

				if (targetNode === undefined) {
					setMoveError("目标节点在快照中不存在 / Target node not found in snapshot");
					return;
				}
				if (targetNode.kind !== "project") {
					setMoveError("目标必须为项目 / Target must be a project");
					return;
				}
				if (targetNode.id === sourceNode.id) {
					setMoveError("不能移动到自身 / Cannot move node into itself");
					return;
				}
				if (sourceNode.kind === "project" && isDescendantOf(targetNode, sourceNode.id)) {
					setMoveError("不能移动到自身后代项目 / Cannot move node into its own descendant");
					return;
				}
				if (targetNode.id === sourceNode.parentId || (isRootTarget && sourceNode.parentId === null)) {
					const msg = "目标已是当前父项目 / Node is already under this project";
					setMoveError(msg);
					setNotice(msg);
					return;
				}

				if (!validateAncestorChain(sourceNode, snapshot) || !validateAncestorChain(targetNode, snapshot)) {
					setMoveError("祖先链无效或存在循环，无法移动 / Invalid or cyclic ancestor chain; move refused");
					return;
				}

				const nextToken = movePreviewToken.current + 1;
				movePreviewToken.current = nextToken;
				const nextPreview = {
					sourceId: sourceNode.id,
					sourceTitle: sourceNode.title,
					sourceKind: sourceNode.kind,
					sessionId: sourceNode.sessionId,
					sourceParentId: sourceNode.parentId,
					targetId: targetNode.id,
					targetTitle: targetNode.title,
					baselineRevision: snapshot.revision,
					token: nextToken
				};
				movePreviewRef.current = nextPreview;
				setMoveError("");
				setMovePreview(nextPreview);
			};

			const moveTo = (targetId, sourceId) => {
				previewMove(targetId, sourceId);
			};

			const confirmMove = async (context) => {
				if (!isMountedRef.current) return;
				if (moveSubmittingRef.current || renameSubmittingRef.current || createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current) return;

				if (context === undefined || context === null) return;
				const preview = movePreviewRef.current;
				if (preview === null) return;
				if (context.token !== movePreviewToken.current) return;
				if (preview.token !== context.token) return;
				if (preview.sourceId !== context.sourceId || preview.targetId !== context.targetId) return;

				const activeSnapshot = snapshotRef.current;
				if (activeSnapshot === null) {
					setMoveError("快照未就绪，无法移动 / Snapshot is not available");
					return;
				}
				if (snapshotStaleRef.current) {
					setMoveError("快照已陈旧失效，拒绝保存 / Snapshot is stale; move refused");
					return;
				}
				if (preview.sourceKind === "conversation") {
					if (selectedRef.current !== preview.sourceId) {
						setMoveError("选区已变更，需重新预览 / Selection changed; please re-preview");
						return;
					}
					if (preview.baselineRevision !== undefined && activeSnapshot.revision !== preview.baselineRevision) {
						setMoveError("快照版本已改变，需重新预览 / Snapshot revision changed; please re-preview");
						return;
					}
				}

				const sourceEl = typeof document === "undefined" ? null : document.querySelector("[data-wo-move-source]");
				if (sourceEl !== null) {
					const domSourceId = sourceEl.getAttribute("data-wo-move-source");
					if (domSourceId !== null && domSourceId !== preview.sourceId) {
						setMoveError("编辑会话目标与DOM不一致 / Target mismatch");
						return;
					}
				}
				const targetEl = typeof document === "undefined" ? null : document.querySelector("[data-wo-move-target]");
				if (targetEl !== null) {
					const domTargetId = targetEl.getAttribute("data-wo-move-target");
					if (domTargetId !== null && domTargetId !== preview.targetId) {
						setMoveError("编辑会话目标与DOM不一致 / Target mismatch");
						return;
					}
				}

				const matchingSources = activeSnapshot.nodes.filter((n) => n.id === preview.sourceId);
				if (matchingSources.length === 0) {
					setMoveError("源节点在当前快照中不存在 / Source node not found in snapshot");
					return;
				}
				if (matchingSources.length > 1) {
					setMoveError("源节点在快照中存在重复，无法移动 / Source node identity is duplicated in snapshot");
					return;
				}
				const source = matchingSources[0];

				if (source.parentId === null || (source.kind === "project" && source.id === activeSnapshot.rootId)) {
					setMoveError("根项目禁止移动 / Root project cannot be moved");
					return;
				}
				if (source.kind !== "project" && source.kind !== "workspace" && source.kind !== "conversation") {
					setMoveError("仅支持移动项目、工作区或普通会话 / Only projects, workspaces, and conversations can be moved");
					return;
				}
				if (source.parentId !== preview.sourceParentId) {
					setMoveError("源节点父级已改变，需重新预览 / Source parent changed; please re-preview");
					return;
				}

				if (source.kind === "conversation") {
					if (typeof source.sessionId !== "string" || source.sessionId.trim().length === 0) {
						setMoveError("会话Session缺失或无效，无法移动 / Session ID missing or invalid; move refused");
						return;
					}
					if (preview.sessionId !== undefined && source.sessionId !== preview.sessionId) {
						setMoveError("会话Session已改变，需重新预览 / Session ID changed; please re-preview");
						return;
					}
					if (source.cwd !== undefined) {
						setMoveError("目录绑定会话禁止移动到项目 / Conversation has directory binding (cwd); move refused");
						return;
					}
					const parentNode = activeSnapshot.nodes.find((n) => n.id === source.parentId);
					if (parentNode === undefined || parentNode.kind !== "project") {
						setMoveError("当前会话归属于工作区而非项目，禁止移动 / Conversation is under workspace; move refused");
						return;
					}
				}

				const isRootTarget = preview.targetId === "root" || (activeSnapshot.rootId !== undefined && preview.targetId === activeSnapshot.rootId);
				const resolvedTargetId = isRootTarget ? (activeSnapshot.rootId || "root") : preview.targetId;
				const matchingTargets = activeSnapshot.nodes.filter((n) => n.id === resolvedTargetId);
				let target = matchingTargets.length > 0 ? matchingTargets[0] : undefined;

				if (target === undefined) {
					if (isRootTarget && source.kind !== "conversation") {
						target = {
							id: activeSnapshot.rootId || "root",
							kind: "project",
							title: "Root",
							parentId: null
						};
					} else {
						setMoveError("目标节点在当前快照中不存在 / Target node not found in snapshot");
						return;
					}
				}
				if (matchingTargets.length > 1) {
					setMoveError("目标节点在快照中存在重复，无法移动 / Target node identity is duplicated in snapshot");
					return;
				}

				if (target.kind !== "project") {
					setMoveError("目标必须为项目 / Target must be a project");
					return;
				}
				if (target.id === source.id) {
					setMoveError("不能移动到自身 / Cannot move node into itself");
					return;
				}
				if (source.kind === "project" && isDescendantOf(target, source.id, activeSnapshot)) {
					setMoveError("不能移动到自身后代项目 / Cannot move node into its own descendant");
					return;
				}
				if (target.id === source.parentId || (isRootTarget && source.parentId === null)) {
					setMoveError("目标已是当前父项目 / Node is already under this project");
					return;
				}

				if (!validateAncestorChain(source, activeSnapshot) || !validateAncestorChain(target, activeSnapshot)) {
					setMoveError("祖先链无效或存在循环，无法移动 / Invalid or cyclic ancestor chain; move refused");
					return;
				}

				moveSubmittingRef.current = true;
				setMoveSubmitting(true);
				setMoveError("");
				setBusy(true);

				refreshRequest.current += 1;
				const generation = moveRequest.current + 1;
				moveRequest.current = generation;

				try {
					const nextSnapshot = await remote.moveNode({ id: preview.sourceId, parentId: preview.targetId }).then(unwrap);
					if (!isMountedRef.current || moveRequest.current !== generation) return;

					if (source.kind === "conversation") {
						if (!nextSnapshot || !Array.isArray(nextSnapshot.nodes)) {
							const msg = "返回快照无效 / Returned snapshot is invalid";
							setMoveError(msg);
							setNotice("移动未确认或失败 / Move unconfirmed or failed: " + msg);
							return;
						}
						const matchingMoved = nextSnapshot.nodes.filter((n) => n.id === preview.sourceId);
						if (matchingMoved.length !== 1) {
							const msg = "返回快照中会话节点不唯一或丢失 / Conversation node count mismatch in returned snapshot";
							setMoveError(msg);
							setNotice("移动未确认或失败 / Move unconfirmed or failed: " + msg);
							return;
						}
						const movedNode = matchingMoved[0];
						if (movedNode.kind !== "conversation" ||
							movedNode.sessionId !== preview.sessionId ||
							movedNode.cwd !== undefined ||
							movedNode.parentId !== preview.targetId) {
							const msg = "返回快照中会话状态或Session漂移 / Conversation state or session mismatch in returned snapshot";
							setMoveError(msg);
							setNotice("移动未确认或失败 / Move unconfirmed or failed: " + msg);
							return;
						}
					}

					setSnapshot(nextSnapshot);
					setSnapshotStale(false);
					setNotice("移动已确认 / Move confirmed");
					movePreviewToken.current += 1;
					movePreviewRef.current = null;
					setMovePreview(null);
					setMoveError("");
					moveSubmittingRef.current = false;
					setMoveSubmitting(false);

					try {
						const [reloadedSnapshot, reportedStatus] = await Promise.all([
							remote.snapshot().then(unwrap),
							remote.status().then(unwrap)
						]);
						if (!isMountedRef.current || moveRequest.current !== generation) return;
						setSnapshot(reloadedSnapshot);
						setStatus(reportedStatus);
						setSnapshotStale(false);
					} catch (refreshErr) {
						if (!isMountedRef.current || moveRequest.current !== generation) return;
						setSnapshotStale(true);
						setNotice("移动已确认；但后续快照刷新失败，显示最后确认快照 / Move confirmed; subsequent refresh failed: " + failureText(refreshErr));
					}
				} catch (error) {
					if (!isMountedRef.current || moveRequest.current !== generation) return;
					moveSubmittingRef.current = false;
					setMoveSubmitting(false);
					const msg = failureText(error);
					setMoveError(msg);
					setNotice("移动未确认或失败 / Move unconfirmed or failed: " + msg);
				} finally {
					if (isMountedRef.current && moveRequest.current === generation) {
						moveSubmittingRef.current = false;
						setMoveSubmitting(false);
						setBusy(false);
					}
				}
			};

			const startRename = (node) => {
				if (!isMountedRef.current) return;
				if (snapshot === null || snapshotStale || renameSubmittingRef.current || moveSubmittingRef.current || createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current) return;
				if (createProjectActive) {
					const msg = "正在创建项目中，请先完成或取消创建 / Project creation in progress; please finish or cancel first";
					setCreateProjectError(msg);
					setNotice(msg);
					return;
				}
				if (linkWorkspaceActive) {
					const msg = "正在关联工作区中，请先完成或取消关联 / Workspace linking in progress; please finish or cancel first";
					setLinkWorkspaceError(msg);
					setNotice(msg);
					return;
				}
				if (linkSessionActive) {
					const msg = "正在关联会话中，请先完成或取消关联 / Session linking in progress; please finish or cancel first";
					setLinkSessionError(msg);
					setNotice(msg);
					return;
				}
				if (movePreviewRef.current !== null) {
					const msg = "正在移动预览中，请先确认或取消移动 / Move in progress; please finish or cancel first";
					setMoveError(msg);
					setNotice(msg);
					return;
				}
				if (node === undefined || node === null) return;
				if (node.kind === "project" && node.parentId === null) return;
				if (node.id === snapshot.rootId) return;
				if (!snapshot.nodes.some((entry) => entry.id === node.id)) return;

				const nextToken = renameToken.current + 1;
				renameToken.current = nextToken;
				renameTargetRef.current = node.id;
				renameDraftRef.current = node.title;
				setRenameTarget(node.id);
				setRenameDraft(node.title);
				setRenameError("");
				setSelected(node.id);
				setMoveMode(true);
			};
			const cancelRename = (context) => {
				if (!isMountedRef.current) return;
				if (renameSubmittingRef.current) return;
				if (context && (renameTargetRef.current !== context.targetId || renameToken.current !== context.token)) return;
				renameToken.current += 1;
				renameTargetRef.current = null;
				renameRequest.current += 1;
				renameDraftRef.current = "";
				setRenameTarget(null);
				setRenameDraft("");
				setRenameError("");
			};
			const handleRenameInput = (event, context) => {
				if (!isMountedRef.current) return;
				if (!context || renameTargetRef.current !== context.targetId || renameToken.current !== context.token) return;
				const nextVal = (event && event.target && typeof event.target.value === "string")
					? event.target.value
					: (typeof event === "string" ? event : "");
				renameDraftRef.current = nextVal;
				setRenameDraft(nextVal);
			};
			const saveRename = async (context) => {
				if (!isMountedRef.current) return;
				if (renameSubmittingRef.current || moveSubmittingRef.current || createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current) return;
				if (!context || renameTargetRef.current !== context.targetId || renameToken.current !== context.token) return;

				const targetId = context.targetId;
				if (targetId === null) return;

				const currentSnapshot = snapshotRef.current;
				if (currentSnapshot === null) {
					setRenameError("快照未就绪，无法重命名 / Snapshot is not available");
					return;
				}
				if (snapshotStaleRef.current) {
					setRenameError("快照已陈旧失效，拒绝保存 / Snapshot is stale; save refused");
					return;
				}

				const target = currentSnapshot.nodes.find((node) => node.id === targetId);
				if (target === undefined) {
					setRenameError("目标节点在当前快照中不存在 / Target node not found in snapshot");
					return;
				}
				if (target.kind === "project" && target.parentId === null) {
					setRenameError("根项目禁止重命名 / Root project cannot be renamed");
					return;
				}
				if (target.id === currentSnapshot.rootId) {
					setRenameError("根节点禁止重命名 / Root node cannot be renamed");
					return;
				}

				const source = typeof document === "undefined" ? null : document.querySelector("[data-wo-rename-source]");
				if (source !== null) {
					const domSourceId = source.getAttribute("data-wo-rename-source");
					if (domSourceId !== null && domSourceId !== targetId) {
						setRenameError("编辑会话目标与DOM不一致 / Target mismatch");
						return;
					}
				}

				const input = typeof document === "undefined" ? null : document.querySelector("[data-wo-rename-input]");
				const rawName = input !== null && typeof input.value === "string" ? input.value : renameDraftRef.current;
				const name = rawName.trim();

				if (name.length === 0 || name.length > 200) {
					setRenameError("Name must be 1–200 characters");
					return;
				}

				if (name === target.title) {
					setRenameError("名称未改变 / Name unchanged");
					return;
				}

				renameSubmittingRef.current = true;
				setRenameSubmitting(true);
				setRenameError("");
				setBusy(true);

				refreshRequest.current += 1;
				const generation = renameRequest.current + 1;
				renameRequest.current = generation;

				try {
					const nextSnapshot = await remote.renameNode({ id: targetId, title: name }).then(unwrap);

					if (renameRequest.current !== generation || !isMountedRef.current) return;

					setSnapshot(nextSnapshot);
					setQuickAccessItems(function (previous) {
						if (previous.length === 0) return previous;
						const existingIds = new Set(nextSnapshot.nodes.map((node) => node.id));
						const filtered = previous.filter((id) => {
							if (!existingIds.has(id)) {
								quickAccessTokensRef.current.delete(id);
								return false;
							}
							return true;
						});
						return filtered.length === previous.length ? previous : filtered;
					});

					renameToken.current += 1;
					renameTargetRef.current = null;
					setRenameTarget(null);
					setRenameDraft("");
					setRenameError("");
					renameSubmittingRef.current = false;
					setRenameSubmitting(false);

					try {
						const [reloadedSnapshot, reportedStatus] = await Promise.all([
							remote.snapshot().then(unwrap),
							remote.status().then(unwrap)
						]);
						if (renameRequest.current !== generation || !isMountedRef.current) return;
						setSnapshot(reloadedSnapshot);
						setStatus(reportedStatus);
						setSnapshotStale(false);
					} catch (refreshErr) {
						if (renameRequest.current !== generation || !isMountedRef.current) return;
						setSnapshotStale(true);
						setNotice("重命名已确认；但后续快照刷新失败，显示最后确认快照 / Rename confirmed; subsequent refresh failed: " + failureText(refreshErr));
					}
				} catch (error) {
					if (renameRequest.current !== generation || !isMountedRef.current) return;

					renameSubmittingRef.current = false;
					setRenameSubmitting(false);

					const msg = failureText(error);
					setRenameError(msg);
					setNotice("重命名未确认或失败 / Rename unconfirmed or failed: " + msg);
				} finally {
					if (renameRequest.current === generation && isMountedRef.current) {
						renameSubmittingRef.current = false;
						setRenameSubmitting(false);
						setBusy(false);
					}
				}
			};
			const openFind = (node) => {
				if (!isMountedRef.current) return;
				const activeSnapshot = snapshotRef.current !== null ? snapshotRef.current : snapshot;
				if (activeSnapshot === null || snapshotStaleRef.current) return;
				if (!node || typeof node.id !== "string") return;
				const liveNode = activeSnapshot.nodes.find((n) => n.id === node.id);
				if (!liveNode || liveNode.kind !== "project") return;

				const nextToken = findToken.current + 1;
				findToken.current = nextToken;
				findScopeRef.current = liveNode.id;
				findQueryRef.current = "";
				findDescendantsRef.current = true;
				findQueryVersion.current = 1;

				setFindScope(liveNode.id);
				setFindQuery("");
				setFindDescendants(true);
				setFindLocated("");
			};
			const closeFind = (context) => {
				if (!isMountedRef.current) return;
				if (context && (context.token !== findToken.current || context.scopeId !== findScopeRef.current)) {
					return;
				}
				findToken.current += 1;
				findScopeRef.current = null;
				findQueryRef.current = "";
				findQueryVersion.current += 1;

				setFindScope(null);
				setFindQuery("");
				setFindLocated("");
			};
			const handleFindQueryChange = (context, newQuery) => {
				if (!isMountedRef.current) return;
				if (context.token !== findToken.current || context.scopeId !== findScopeRef.current) return;
				findQueryRef.current = newQuery;
				findQueryVersion.current += 1;
				setFindQuery(newQuery);
			};
			const handleFindClear = (context) => {
				if (!isMountedRef.current) return;
				if (context.token !== findToken.current || context.scopeId !== findScopeRef.current) return;
				findQueryRef.current = "";
				findQueryVersion.current += 1;
				setFindQuery("");
			};
			const handleFindModeToggle = (context) => {
				if (!isMountedRef.current) return;
				if (context.token !== findToken.current || context.scopeId !== findScopeRef.current) return;
				const nextMode = !findDescendantsRef.current;
				findDescendantsRef.current = nextMode;
				findQueryVersion.current += 1;
				setFindDescendants(nextMode);
			};
			const pathOf = (node) => {
				const activeSnapshot = snapshotRef.current !== null ? snapshotRef.current : snapshot;
				const names = [];
				const visited = new Set();
				let cursor = node;
				while (cursor !== undefined) {
					if (visited.has(cursor.id)) break;
					visited.add(cursor.id);
					names.unshift(cursor.title);
					if (cursor.parentId === null || activeSnapshot === null) break;
					cursor = activeSnapshot.nodes.find((entry) => entry.id === cursor.parentId);
				}
				return names.join(" / ");
			};
			const findQueryText = findQuery.trim().toLowerCase();
			const activeSnapshotForFind = snapshotRef.current !== null ? snapshotRef.current : snapshot;
			const findResults = findScope === null || activeSnapshotForFind === null || findQueryText.length === 0
				? []
				: activeSnapshotForFind.nodes.filter((node) => node.id !== findScope && node.title.toLowerCase().includes(findQueryText) && (findDescendants ? isDescendantOf(node, findScope, activeSnapshotForFind) : node.parentId === findScope));
			const handleFindLocate = (resultIntent) => {
				if (!isMountedRef.current) return false;
				if (resultIntent.token !== findToken.current || resultIntent.scopeId !== findScopeRef.current) {
					return false;
				}
				if (resultIntent.queryVersion !== findQueryVersion.current) {
					return false;
				}
				const activeSnapshot = snapshotRef.current !== null ? snapshotRef.current : snapshot;
				if (activeSnapshot === null) {
					setFindLocated("快照未就绪，无法定位 / Snapshot is not available");
					return false;
				}
				if (snapshotStaleRef.current) {
					setFindLocated("快照已陈旧失效，拒绝定位 / Snapshot is stale; locate refused");
					return false;
				}
				const matchingScopes = activeSnapshot.nodes.filter((n) => n.id === resultIntent.scopeId);
				if (matchingScopes.length !== 1) {
					setFindLocated("搜索范围不存在或重复，无法定位 / Search scope missing or ambiguous; locate refused");
					return false;
				}
				const liveScope = matchingScopes[0];
				if (liveScope.kind !== "project") {
					setFindLocated("搜索范围不是有效项目，无法定位 / Search scope is not a valid project; locate refused");
					return false;
				}
				const matchingNodes = activeSnapshot.nodes.filter((n) => n.id === resultIntent.targetId);
				if (matchingNodes.length !== 1) {
					setFindLocated("目标身份重复或不存在，拒绝定位 / Target identity ambiguous; locate refused");
					return false;
				}
				const liveTarget = matchingNodes[0];
				const visitedAncestors = new Set();
				visitedAncestors.add(liveTarget.id);
				let ancCursor = liveTarget;
				let ancChainValid = true;
				while (ancCursor !== undefined && ancCursor.parentId !== null) {
					const p = activeSnapshot.nodes.find((e) => e.id === ancCursor.parentId);
					if (p === undefined || visitedAncestors.has(p.id)) {
						ancChainValid = false;
						break;
					}
					visitedAncestors.add(p.id);
					ancCursor = p;
				}
				if (!ancChainValid) {
					setFindLocated("祖先链无效或存在循环，无法定位 / Invalid or cyclic ancestor chain; locate refused");
					return false;
				}
				const inScope = resultIntent.descendants
					? isDescendantOf(liveTarget, resultIntent.scopeId, activeSnapshot)
					: liveTarget.parentId === resultIntent.scopeId;
				if (!inScope) {
					setFindLocated("目标已移出搜索范围，无法定位 / Target moved out of scope");
					return false;
				}
				if (!liveTarget.title.toLowerCase().includes(resultIntent.queryText)) {
					setFindLocated("目标名称不再匹配当前查询 / Target name no longer matches query");
					return false;
				}
				return locateNode(resultIntent.targetId, { findIntent: resultIntent });
			};
			const locateNode = (id, options) => {
				if (!isMountedRef.current) return false;
				const onReport = typeof options?.onReport === "function" ? options.onReport : null;
				const isTaskSource = options?.isTaskSource === true;
				const taskIntent = options?.taskIntent ?? null;
				const findIntent = options?.findIntent ?? null;
				const quickAccessIntent = options?.quickAccessIntent ?? options?.quickAccess ?? null;

				if (quickAccessIntent !== null) {
					const token = quickAccessIntent.membershipToken ?? quickAccessIntent.token;
					if (!quickAccessItemsRef.current.includes(id)) return false;
					if (quickAccessTokensRef.current.get(id) !== token) return false;
				}

				const activeSnapshot = snapshotRef.current !== null ? snapshotRef.current : snapshot;
				const activeStale = snapshotStaleRef.current;

				if (activeSnapshot === null) {
					if (quickAccessIntent !== null) return false;
					const msg = "快照未就绪，无法定位 / Snapshot is not available";
					setFindLocated(msg);
					if (onReport) onReport(msg, "error");
					return false;
				}
				if (activeStale) {
					if (quickAccessIntent !== null) return false;
					const msg = "快照已陈旧失效，拒绝定位 / Snapshot is stale; locate refused";
					setFindLocated(msg);
					if (onReport) onReport(msg, "error");
					return false;
				}
				const matchingNodes = activeSnapshot.nodes.filter((node) => node.id === id);
				if (matchingNodes.length !== 1) {
					if (quickAccessIntent !== null) return false;
					const msg = isTaskSource ? "源不在当前树中 / Source conversation not found in tree" : "目标在当前快照中不存在 / Target is no longer in the current tree";
					setFindLocated(msg);
					if (onReport) onReport(msg, "error");
					return false;
				}
				const target = matchingNodes[0];
				if (quickAccessIntent !== null) {
					const kind = quickAccessIntent.nodeKind ?? quickAccessIntent.kind;
					if (target.parentId === null) return false;
					if (target.kind !== kind || !["project", "workspace", "conversation"].includes(target.kind)) return false;
				}
				if (isTaskSource && target.kind !== "conversation") {
					const msg = "目标不是普通会话，无法定位 / Target is not a conversation; locate refused";
					setFindLocated(msg);
					if (onReport) onReport(msg, "error");
					return false;
				}
				const ancestors = new Set();
				const visited = new Set();
				let cursor = target;
				let chainValid = true;
				visited.add(cursor.id);
				while (cursor !== undefined && cursor.parentId !== null) {
					const parent = activeSnapshot.nodes.find((entry) => entry.id === cursor.parentId);
					if (parent === undefined) {
						chainValid = false;
						break;
					}
					if (visited.has(parent.id)) {
						chainValid = false;
						break;
					}
					visited.add(parent.id);
					if (parent.kind === "project") ancestors.add(parent.id);
					cursor = parent;
				}
				if (!chainValid) {
					if (quickAccessIntent !== null) return false;
					const msg = "祖先链无效或存在循环，无法定位 / Invalid or cyclic ancestor chain; locate refused";
					setFindLocated(msg);
					if (onReport) onReport(msg, "error");
					return false;
				}

				setVisibleSections(function (previous) {
					if (previous.has("projects")) return previous;
					const next = new Set(previous);
					next.add("projects");
					return next;
				});
				setProjectsCollapsed(false);
				setCollapsed(function (previous) {
					const next = new Set(previous);
					for (const ancestor of ancestors) next.delete(ancestor);
					return next;
				});
				setSelected(id);
				setTitle(target.title);
				if (!renameSubmittingRef.current && !moveSubmittingRef.current) {
					renameToken.current += 1;
					renameTargetRef.current = null;
					setRenameTarget(null);
				}
				setFindLocated(`Located ${target.title} (定位准备中 / selecting)`);
				if (onReport) onReport(`Located ${target.title} (定位中 / selecting)`, "locating");

				const generation = locateRequest.current + 1;
				locateRequest.current = generation;
				if (locateTimer.current !== null) {
					clearTimeout(locateTimer.current);
					locateTimer.current = null;
				}
				locateTimer.current = setTimeout(function () {
					locateTimer.current = null;
					if (!isMountedRef.current || locateRequest.current !== generation) return;

					if (taskIntent !== null) {
						if (!taskCenterOpenRef.current || taskCenterSelectedRef.current !== taskIntent.taskId) return;
						if (taskCenterStatusRef.current === "loading") {
							const msg = "Task Center reload is still loading; queued locate scroll cancelled (source read unconfirmed)";
							setFindLocated(msg);
							if (onReport) onReport(msg, "cancelled");
							return;
						}
						const liveLedger = taskCenterLedgerRef.current;
						const liveTask = liveLedger && Array.isArray(liveLedger.tasks)
							? liveLedger.tasks.find((t) => t.taskId === taskIntent.taskId)
							: null;
						if (liveTask === null || liveTask.sourceConversationId !== taskIntent.sourceConversationId) {
							return;
						}
						const liveSource = liveLedger && Array.isArray(liveLedger.sources)
							? liveLedger.sources.find((source) => source.conversationId === taskIntent.sourceConversationId)
							: null;
						if (liveSource?.blockedReason === "source-archived") {
							const msg = "Source is archived; queued locate scroll cancelled";
							setFindLocated(msg);
							if (onReport) onReport(msg, "cancelled");
							return;
						}
						if (taskCenterStatusRef.current === "error") {
							const msg = "Task Center error; queued locate scroll cancelled";
							setFindLocated(msg);
							if (onReport) onReport(msg, "cancelled");
							return;
						}
					}

					if (findIntent !== null) {
						if (findScopeRef.current !== findIntent.scopeId ||
							findToken.current !== findIntent.token ||
							findQueryVersion.current !== findIntent.queryVersion) {
							return;
						}
					}

					if (quickAccessIntent !== null) {
						const token = quickAccessIntent.membershipToken ?? quickAccessIntent.token;
						const kind = quickAccessIntent.nodeKind ?? quickAccessIntent.kind;
						if (!quickAccessItemsRef.current.includes(id) ||
							quickAccessTokensRef.current.get(id) !== token) {
							return;
						}
						const currentSnapshot = snapshotRef.current;
						const currentStale = snapshotStaleRef.current;
						if (currentStale || currentSnapshot === null) {
							return;
						}
						const liveTargets = currentSnapshot.nodes.filter((node) => node.id === id);
						if (liveTargets.length !== 1) {
							return;
						}
						const liveTarget = liveTargets[0];
						if (liveTarget.parentId === null || liveTarget.kind !== kind || !["project", "workspace", "conversation"].includes(liveTarget.kind)) {
							return;
						}
						const liveVisited = new Set();
						let liveCursor = liveTarget;
						let liveChainValid = true;
						liveVisited.add(liveCursor.id);
						while (liveCursor !== undefined && liveCursor.parentId !== null) {
							const parent = currentSnapshot.nodes.find((entry) => entry.id === liveCursor.parentId);
							if (parent === undefined || liveVisited.has(parent.id)) {
								liveChainValid = false;
								break;
							}
							liveVisited.add(parent.id);
							liveCursor = parent;
						}
						if (!liveChainValid) {
							return;
						}
					}

					const currentSnapshot = snapshotRef.current;
					const currentStale = snapshotStaleRef.current;
					if (currentStale || currentSnapshot === null || !currentSnapshot.nodes.some((node) => node.id === id)) {
						const msg = `Located ${target.title} (快照失效或目标移除，滚动取消 / snapshot became stale; scroll cancelled)`;
						setFindLocated(msg);
						if (onReport) onReport(msg, "cancelled");
						return;
					}

					if (taskIntent !== null) {
						const liveTaskSources = currentSnapshot.nodes.filter((node) => node.id === taskIntent.sourceConversationId);
						if (liveTaskSources.length !== 1 || liveTaskSources[0].kind !== "conversation") {
							const msg = "Task source is no longer a conversation; queued locate scroll cancelled";
							setFindLocated(msg);
							if (onReport) onReport(msg, "cancelled");
							return;
						}
					}

					if (findIntent !== null) {
						const liveTargets = currentSnapshot.nodes.filter((n) => n.id === id);
						if (liveTargets.length !== 1) {
							const msg = `Located ${target.title} (目标重复或移除，滚动取消 / target ambiguous or removed; scroll cancelled)`;
							setFindLocated(msg);
							if (onReport) onReport(msg, "cancelled");
							return;
						}
						const liveTarget = liveTargets[0];
						const liveScopes = currentSnapshot.nodes.filter((n) => n.id === findIntent.scopeId);
						if (liveScopes.length !== 1 || liveScopes[0].kind !== "project") {
							const msg = `Located ${target.title} (搜索范围失效，滚动取消 / search scope invalidated; scroll cancelled)`;
							setFindLocated(msg);
							if (onReport) onReport(msg, "cancelled");
							return;
						}
						const inScope = findIntent.descendants
							? isDescendantOf(liveTarget, findIntent.scopeId, currentSnapshot)
							: liveTarget.parentId === findIntent.scopeId;
						if (!inScope) {
							const msg = `Located ${target.title} (目标已移出范围，滚动取消 / target moved out of scope; scroll cancelled)`;
							setFindLocated(msg);
							if (onReport) onReport(msg, "cancelled");
							return;
						}
						if (!liveTarget.title.toLowerCase().includes(findIntent.queryText)) {
							const msg = `Located ${target.title} (目标名称不再匹配查询，滚动取消 / target name no longer matches query; scroll cancelled)`;
							setFindLocated(msg);
							if (onReport) onReport(msg, "cancelled");
							return;
						}
					}
					const currentTargets = currentSnapshot.nodes.filter((n) => n.id === id);
					const currentTitle = currentTargets.length === 1 ? currentTargets[0].title : target.title;
					if (typeof document === "undefined") {
						setFindLocated(`Located ${currentTitle}`);
						if (onReport) onReport(`Located ${currentTitle} (无DOM环境，滚动未验证 / DOM unavailable)`, "unverified");
						return;
					}
					const row = document.querySelector(`[data-wo-node-id="${id}"]`);
					if (row !== null) {
						if (typeof row.scrollIntoView === "function") {
							row.scrollIntoView({ block: "center" });
						}
						setFindLocated(`Located ${currentTitle}`);
						if (onReport) onReport(`Located ${currentTitle}`, "located");
					} else {
						const msg = `Located ${currentTitle} (未找到DOM行 / row not found)`;
						setFindLocated(msg);
						if (onReport) onReport(msg, "missing-row");
					}
				}, 0);
				return true;
			};
			const toggleQuickAccess = (id, explicitMode, expectedToken) => {
				if (!isMountedRef.current) return;
				if (snapshotStaleRef.current) return;
				const activeSnapshot = snapshotRef.current || snapshot;
				if (activeSnapshot === null || !Array.isArray(activeSnapshot.nodes)) return;
				if (id === activeSnapshot.rootId) return;
				const matches = activeSnapshot.nodes.filter((node) => node.id === id);
				if (matches.length !== 1) return;
				const target = matches[0];
				if (target.parentId === null || (target.kind !== "project" && target.kind !== "workspace" && target.kind !== "conversation")) return;

				const isCurrentlyPinned = quickAccessItemsRef.current.includes(id);

				if (explicitMode === "pin") {
					if (isCurrentlyPinned) return;
					const nextToken = ++quickAccessTokenSeqRef.current;
					quickAccessTokensRef.current.set(id, nextToken);
					setQuickAccessItems(function (previous) {
						if (previous.includes(id)) return previous;
						return previous.concat(id);
					});
					return;
				}

				if (explicitMode === "unpin") {
					if (!isCurrentlyPinned) return;
					const currentToken = quickAccessTokensRef.current.get(id);
					if (expectedToken !== undefined && currentToken !== expectedToken) return;
					quickAccessTokensRef.current.delete(id);
					setQuickAccessItems(function (previous) {
						return previous.filter((item) => item !== id);
					});
					return;
				}

				if (isCurrentlyPinned) {
					const currentToken = quickAccessTokensRef.current.get(id);
					if (expectedToken !== undefined && currentToken !== expectedToken) return;
					quickAccessTokensRef.current.delete(id);
					setQuickAccessItems(function (previous) {
						return previous.filter((item) => item !== id);
					});
				} else {
					const nextToken = ++quickAccessTokenSeqRef.current;
					quickAccessTokensRef.current.set(id, nextToken);
					setQuickAccessItems(function (previous) {
						if (previous.includes(id)) return previous;
						return previous.concat(id);
					});
				}
			};
			const moveQuickAccessUp = (id, expectedToken) => {
				if (!isMountedRef.current) return;
				if (snapshotStaleRef.current) return;
				const currentToken = quickAccessTokensRef.current.get(id);
				if (expectedToken !== undefined && currentToken !== expectedToken) return;
				if (!quickAccessItemsRef.current.includes(id)) return;
				setQuickAccessItems(function (previous) {
					const index = previous.indexOf(id);
					if (index <= 0) return previous;
					const copy = previous.slice();
					const temp = copy[index - 1];
					copy[index - 1] = copy[index];
					copy[index] = temp;
					return copy;
				});
			};
			const moveQuickAccessDown = (id, expectedToken) => {
				if (!isMountedRef.current) return;
				if (snapshotStaleRef.current) return;
				const currentToken = quickAccessTokensRef.current.get(id);
				if (expectedToken !== undefined && currentToken !== expectedToken) return;
				if (!quickAccessItemsRef.current.includes(id)) return;
				setQuickAccessItems(function (previous) {
					const index = previous.indexOf(id);
					if (index < 0 || index >= previous.length - 1) return previous;
					const copy = previous.slice();
					const temp = copy[index + 1];
					copy[index + 1] = copy[index];
					copy[index] = temp;
					return copy;
				});
			};
			const removeQuickAccess = (id, expectedToken) => {
				if (!isMountedRef.current) return;
				const currentToken = quickAccessTokensRef.current.get(id);
				if (expectedToken !== undefined && currentToken !== expectedToken) return;
				quickAccessTokensRef.current.delete(id);
				setQuickAccessItems(function (previous) {
					return previous.filter((item) => item !== id);
				});
			};
			const isCurrentTaskCenterDetailAction = (task, relationViewLifetime) => {
				if (!isMountedRef.current) return false;
				if (!Number.isSafeInteger(relationViewLifetime) || relationViewLifetime < 0 || relationViewLifetime !== taskCenterRelationViewLifetime.current) return false;
				if (!taskCenterOpenRef.current) return false;
				if (task === null || task === undefined || typeof task.taskId !== "string" || !task.taskId) return false;
				if (typeof task.sourceConversationId !== "string" || !task.sourceConversationId) return false;
				if (taskCenterSelectedRef.current !== task.taskId) return false;
				const currentLedger = taskCenterLedgerRef.current;
				if (currentLedger === null || !Array.isArray(currentLedger.tasks)) return false;
				const matching = currentLedger.tasks.filter((current) => current.taskId === task.taskId && current.sourceConversationId === task.sourceConversationId);
				return matching.length === 1;
			};
			const pinTask = (task, expectedPinIntent) => {
				if (!isMountedRef.current) return;
				if (snapshotStaleRef.current) return;
				if (!taskCenterOpenRef.current || taskCenterStatusRef.current !== "ready") return;
				if (task === null || task === undefined) return;
				if (taskCenterSelectedRef.current !== task.taskId) return;
				const currentLedger = taskCenterLedgerRef.current;
				if (currentLedger === null || !Array.isArray(currentLedger.tasks)) return;
				const matching = currentLedger.tasks.filter((t) => t.taskId === task.taskId && t.sourceConversationId === task.sourceConversationId);
				if (matching.length !== 1) return;

				const taskKey = `${task.taskId}:${task.sourceConversationId}`;
				const currentPinIntent = taskPinIntentRef.current.get(taskKey) || 0;
				if (expectedPinIntent !== undefined && expectedPinIntent !== currentPinIntent) {
					return;
				}

				const alreadyPinned = quickAccessTasksRef.current.some((item) => item.taskId === task.taskId && item.sourceConversationId === task.sourceConversationId);
				if (alreadyPinned) return;

				const nextToken = ++taskMembershipSeqRef.current;
				taskMembershipTokensRef.current.set(taskKey, nextToken);

				setQuickAccessTasks(function (previous) {
					if (previous.some((item) => item.taskId === task.taskId && item.sourceConversationId === task.sourceConversationId)) {
						return previous;
					}
					return previous.concat({
						kind: "task",
						taskId: task.taskId,
						sourceConversationId: task.sourceConversationId
					});
				});
			};
			const unpinTask = (taskId, sourceConversationId, expectedToken) => {
				if (!isMountedRef.current) return;
				if (!taskId) return;
				const taskKey = `${taskId}:${sourceConversationId}`;
				const currentToken = taskMembershipTokensRef.current.get(taskKey);
				if (expectedToken !== undefined && currentToken !== expectedToken) {
					return;
				}

				taskMembershipTokensRef.current.delete(taskKey);
				taskPinIntentRef.current.set(taskKey, (taskPinIntentRef.current.get(taskKey) || 0) + 1);

				setQuickAccessTasks(function (previous) {
					return previous.filter((item) => {
						if (item.taskId !== taskId) return true;
						if (sourceConversationId !== undefined && sourceConversationId !== null && item.sourceConversationId !== sourceConversationId) {
							return true;
						}
						return false;
					});
				});
			};
			const moveQuickAccessTaskUp = (taskId, sourceConversationId, expectedToken) => {
				if (!isMountedRef.current) return;
				if (snapshotStaleRef.current) return;
				if (!taskId) return;
				const taskKey = `${taskId}:${sourceConversationId}`;
				const currentToken = taskMembershipTokensRef.current.get(taskKey);
				if (expectedToken !== undefined && currentToken !== expectedToken) {
					return;
				}
				if (!quickAccessTasksRef.current.some((it) => it.taskId === taskId && (sourceConversationId === undefined || sourceConversationId === null || it.sourceConversationId === sourceConversationId))) {
					return;
				}
				setQuickAccessTasks(function (previous) {
					const matchingIndices = [];
					for (let i = 0; i < previous.length; i++) {
						const it = previous[i];
						if (it.taskId === taskId && (sourceConversationId === undefined || sourceConversationId === null || it.sourceConversationId === sourceConversationId)) {
							matchingIndices.push(i);
						}
					}
					if (matchingIndices.length !== 1) return previous;
					const index = matchingIndices[0];
					if (index <= 0) return previous;
					const copy = previous.slice();
					const temp = copy[index - 1];
					copy[index - 1] = copy[index];
					copy[index] = temp;
					return copy;
				});
			};
			const moveQuickAccessTaskDown = (taskId, sourceConversationId, expectedToken) => {
				if (!isMountedRef.current) return;
				if (snapshotStaleRef.current) return;
				if (!taskId) return;
				const taskKey = `${taskId}:${sourceConversationId}`;
				const currentToken = taskMembershipTokensRef.current.get(taskKey);
				if (expectedToken !== undefined && currentToken !== expectedToken) {
					return;
				}
				if (!quickAccessTasksRef.current.some((it) => it.taskId === taskId && (sourceConversationId === undefined || sourceConversationId === null || it.sourceConversationId === sourceConversationId))) {
					return;
				}
				setQuickAccessTasks(function (previous) {
					const matchingIndices = [];
					for (let i = 0; i < previous.length; i++) {
						const it = previous[i];
						if (it.taskId === taskId && (sourceConversationId === undefined || sourceConversationId === null || it.sourceConversationId === sourceConversationId)) {
							matchingIndices.push(i);
						}
					}
					if (matchingIndices.length !== 1) return previous;
					const index = matchingIndices[0];
					if (index < 0 || index >= previous.length - 1) return previous;
					const copy = previous.slice();
					const temp = copy[index + 1];
					copy[index + 1] = copy[index];
					copy[index] = temp;
					return copy;
				});
			};
			const loadTaskCenter = async (options) => {
				if (!isMountedRef.current) return;
				const isReload = Boolean(options && options.isReload);
				if (isReload) {
					if (!taskCenterOpenRef.current) return;
					if (options.token === undefined || options.token !== taskCenterToken.current) return;
				} else {
					taskCenterRelationViewLifetime.current += 1;
					taskCenterToken.current += 1;
				}
				const preserveFilter = Boolean(options && options.preserveFilter);
				if (!preserveFilter) {
					setTaskCenterSourceFilter("");
					taskCenterSourceFilterRef.current = "";
				}
				const generation = taskCenterRequest.current + 1;
				taskCenterRequest.current = generation;
				setTaskCenterLocateNotice("");
				setTaskCenterLocateState("idle");
				setTaskCenterOpen(true);
				taskCenterOpenRef.current = true;
				setTaskCenterStatus("loading");
				setTaskCenterError("");

				const currentSelectedId = taskCenterSelectedRef.current;
				let frozenIdentity = null;
				if (currentSelectedId !== null) {
					const currentRawTasks = taskCenterLedgerRef.current && Array.isArray(taskCenterLedgerRef.current.tasks)
						? taskCenterLedgerRef.current.tasks
						: [];
					const matchingPrior = currentRawTasks.filter((t) => t.taskId === currentSelectedId);
					if (matchingPrior.length === 1) {
						frozenIdentity = {
							taskId: matchingPrior[0].taskId,
							sourceConversationId: matchingPrior[0].sourceConversationId
						};
					} else {
						setTaskCenterSelected(null);
						taskCenterSelectedRef.current = null;
					}
				}

				let pLedger;
				try {
					pLedger = Promise.resolve(remote.taskLedger()).then(unwrap);
					pLedger.catch(() => {});
				} catch (syncErr) {
					if (!isMountedRef.current || taskCenterRequest.current !== generation || !taskCenterOpenRef.current) return;
					setTaskCenterStatus("error");
					setTaskCenterError(failureText(syncErr));
					return;
				}
				try {
					const ledger = await pLedger;
					if (!isMountedRef.current || taskCenterRequest.current !== generation || !taskCenterOpenRef.current) return;
					if (frozenIdentity !== null) {
						const newRawTasks = ledger && Array.isArray(ledger.tasks) ? ledger.tasks : [];
						const matchingNew = newRawTasks.filter((t) => t.taskId === frozenIdentity.taskId);
						if (matchingNew.length > 1 || (matchingNew.length === 1 && matchingNew[0].sourceConversationId !== frozenIdentity.sourceConversationId)) {
							setTaskCenterSelected(null);
							setTaskCenterStatus("error");
							setTaskCenterError("任务身份未确认 / Task identity unconfirmed: source drifted or duplicate ID in ledger");
							return;
						}
						setTaskCenterLedger(ledger);
						setTaskCenterStatus("ready");
						if (matchingNew.length === 0) {
							setTaskCenterSelected(null);
						} else {
							const activeFilter = taskCenterSourceFilterRef.current;
							if (activeFilter !== "" && matchingNew[0].sourceConversationId !== activeFilter) {
								setTaskCenterSelected(null);
							} else {
								setTaskCenterSelected(frozenIdentity.taskId);
							}
						}
					} else {
						setTaskCenterLedger(ledger);
						setTaskCenterStatus("ready");
						setTaskCenterSelected(null);
					}
				} catch (error) {
					if (!isMountedRef.current || taskCenterRequest.current !== generation || !taskCenterOpenRef.current) return;
					setTaskCenterError(failureText(error));
					setTaskCenterStatus("error");
				}
			};
			const closeTaskCenter = (relationViewLifetime) => {
				if (!Number.isSafeInteger(relationViewLifetime) || relationViewLifetime < 0 || relationViewLifetime !== taskCenterRelationViewLifetime.current) return;
				if (!isMountedRef.current) return;
				if (!taskCenterOpenRef.current) return;
				taskCenterRelationViewLifetime.current += 1;
				taskCenterToken.current += 1;
				taskCenterOpenRef.current = false;
				taskCenterRequest.current += 1;
				locateRequest.current += 1;
				if (locateTimer.current !== null) {
					clearTimeout(locateTimer.current);
					locateTimer.current = null;
				}
				setTaskCenterLocateNotice("");
				setTaskCenterLocateState("idle");
				setTaskCenterOpen(false);
				setTaskCenterSelected(null);
				setTaskCenterSourceFilter("");
				taskCenterSourceFilterRef.current = "";
			};
			const selectTaskCenterTask = (task, relationViewLifetime) => {
				if (!Number.isSafeInteger(relationViewLifetime) || relationViewLifetime < 0 || relationViewLifetime !== taskCenterRelationViewLifetime.current) return;
				if (!isMountedRef.current) return;
				if (!taskCenterOpenRef.current) return;
				if (taskCenterStatusRef.current === "loading") return;
				if (task === null || task === undefined || typeof task.taskId !== "string") return;
				const currentFilter = taskCenterSourceFilterRef.current;
				if (currentFilter !== "" && task.sourceConversationId !== currentFilter) {
					return;
				}
				const currentLedger = taskCenterLedgerRef.current;
				if (currentLedger === null || !Array.isArray(currentLedger.tasks)) return;
				const matchingTasks = currentLedger.tasks.filter((t) => t.taskId === task.taskId);
				if (matchingTasks.length !== 1) return;
				if (matchingTasks[0].sourceConversationId !== task.sourceConversationId) return;
				setTaskCenterSelected(task.taskId);
				setTaskCenterLocateNotice("");
				setTaskCenterLocateState("idle");
			};
			const handleTaskCenterFilterChange = (valOrEvt, relationViewLifetime) => {
				if (!Number.isSafeInteger(relationViewLifetime) || relationViewLifetime < 0 || relationViewLifetime !== taskCenterRelationViewLifetime.current) return;
				if (!isMountedRef.current) return;
				if (!taskCenterOpenRef.current) return;
				if (taskCenterStatusRef.current === "loading") return;
				const nextVal = (typeof valOrEvt === "object" && valOrEvt !== null && valOrEvt.target)
					? valOrEvt.target.value
					: (typeof valOrEvt === "string" ? valOrEvt : "");
				const targetFilter = nextVal.trim();
				setTaskCenterSourceFilter(targetFilter);
				taskCenterSourceFilterRef.current = targetFilter;

				const currentSelectedId = taskCenterSelectedRef.current;
				if (currentSelectedId !== null) {
					const liveLedger = taskCenterLedgerRef.current;
					const matchingTasks = liveLedger && Array.isArray(liveLedger.tasks)
						? liveLedger.tasks.filter((t) => t.taskId === currentSelectedId)
						: [];
					if (matchingTasks.length !== 1 || (targetFilter !== "" && matchingTasks[0].sourceConversationId !== targetFilter)) {
						setTaskCenterSelected(null);
						setTaskCenterLocateNotice("");
						setTaskCenterLocateState("idle");
					}
				}
				locateRequest.current += 1;
				if (locateTimer.current !== null) {
					clearTimeout(locateTimer.current);
					locateTimer.current = null;
				}
			};
			const taskCenterTasks = taskCenterLedger === null ? [] : (function () {
				const seen = new Set();
				const rows = [];
				for (const task of taskCenterLedger.tasks) {
					if (seen.has(task.taskId)) continue;
					seen.add(task.taskId);
					rows.push(task);
				}
				return rows;
			})();
			const filteredTaskCenterTasks = taskCenterSourceFilter === ""
				? taskCenterTasks
				: taskCenterTasks.filter((task) => task.sourceConversationId === taskCenterSourceFilter);
			const taskCenterSelectedTask = (function () {
				if (taskCenterSelected === null || taskCenterLedger === null || !Array.isArray(taskCenterLedger.tasks)) {
					return null;
				}
				const matching = taskCenterLedger.tasks.filter((task) => task.taskId === taskCenterSelected);
				if (matching.length !== 1) {
					return null;
				}
				const target = matching[0];
				if (taskCenterSourceFilter !== "" && target.sourceConversationId !== taskCenterSourceFilter) {
					return null;
				}
				return target;
			})();
			const locateTaskSource = (task) => {
				if (!isMountedRef.current) return;
				if (!taskCenterOpenRef.current || taskCenterStatusRef.current !== "ready") return;
				const selectedTaskId = taskCenterSelectedRef.current;
				if (selectedTaskId === null) return;
				if (task === null || task === undefined || task.taskId !== selectedTaskId) return;

				const currentLedger = taskCenterLedgerRef.current;
				if (currentLedger === null || !Array.isArray(currentLedger.tasks)) return;

				const matchingTasks = currentLedger.tasks.filter((t) => t.taskId === task.taskId);
				if (matchingTasks.length !== 1) {
					setTaskCenterLocateNotice("任务缺失或存在歧义，无法定位 / Task missing or ambiguous; locate refused");
					setTaskCenterLocateState("error");
					return;
				}

				const taskRecord = matchingTasks[0];
				if (taskRecord.sourceConversationId !== task.sourceConversationId) return;
				const sourceId = taskRecord.sourceConversationId;

				const sourceRecord = Array.isArray(currentLedger.sources)
					? currentLedger.sources.find((s) => s.conversationId === sourceId)
					: null;
				if (sourceRecord?.blockedReason === "source-archived") {
					setTaskCenterLocateNotice("来源已归档，拒绝定位 / Source is archived; locate refused");
					setTaskCenterLocateState("error");
					return;
				}

				const intent = { taskId: selectedTaskId, sourceConversationId: sourceId };
				locateNode(sourceId, {
					isTaskSource: true,
					taskIntent: intent,
					onReport: (notice, state) => {
						setTaskCenterLocateNotice(notice);
						setTaskCenterLocateState(state);
					}
				});
			};

			const taskRows = (ledger, sourceId) => ledger === null || sourceId === null
				? []
				: ledger.tasks.filter((task) => task.sourceConversationId === sourceId).slice().sort((a, b) => a.depth - b.depth || a.taskId.localeCompare(b.taskId));
			const hasLiveTaskSource = (sourceId) => {
				const activeSnapshot = snapshotRef.current;
				if (snapshotStaleRef.current || activeSnapshot === null || !Array.isArray(activeSnapshot.nodes)) return false;
				const matchingSources = activeSnapshot.nodes.filter((candidate) => candidate !== null && candidate.id === sourceId);
				return matchingSources.length === 1 && matchingSources[0].kind === "conversation";
			};
			const loadTasks = async (sourceId, token) => {
				if (!isMountedRef.current) return;
				if (taskSourceRef.current !== sourceId || taskToken.current !== token) return;
				const generation = taskRequest.current + 1;
				taskRequest.current = generation;
				setTaskStatus("loading");
				taskStatusRef.current = "loading";
				setTaskError("");
				let pLedger;
				try {
					pLedger = Promise.resolve(remote.taskLedger()).then(unwrap);
					pLedger.catch(() => {});
				} catch (syncErr) {
					if (!isMountedRef.current || taskRequest.current !== generation || taskSourceRef.current !== sourceId || taskToken.current !== token) return;
					setTaskStatus("error");
					taskStatusRef.current = "error";
					setTaskError(failureText(syncErr));
					return;
				}
				try {
					const next = await pLedger;
					if (!isMountedRef.current || taskRequest.current !== generation || taskSourceRef.current !== sourceId || taskToken.current !== token) return;
					setTaskLedger(next);
					taskLedgerRef.current = next;
					setTaskStatus("loaded");
					taskStatusRef.current = "loaded";
				} catch (error) {
					if (!isMountedRef.current || taskRequest.current !== generation || taskSourceRef.current !== sourceId || taskToken.current !== token) return;
					setTaskError(failureText(error));
					setTaskStatus("error");
					taskStatusRef.current = "error";
				}
			};
			const navigateToTaskDetail = async (intent) => {
				if (!isMountedRef.current || intent === null || intent === undefined) return;
				if (intent.quickAccessTaskIntent) {
					const qi = intent.quickAccessTaskIntent;
					const taskKey = `${qi.taskId}:${qi.sourceConversationId}`;
					const tokenValid = taskMembershipTokensRef.current.get(taskKey) === qi.membershipToken &&
						quickAccessTasksRef.current.some((t) => t.taskId === qi.taskId && t.sourceConversationId === qi.sourceConversationId);
					if (!tokenValid) return;
				}
				const generation = taskCenterRequest.current + 1;
				taskCenterRequest.current = generation;
				taskCenterToken.current += 1;

				setTaskCenterSourceFilter("");
				taskCenterSourceFilterRef.current = "";
				setTaskCenterLocateNotice("");
				setTaskCenterLocateState("idle");
				locateRequest.current += 1;
				if (locateTimer.current !== null) {
					clearTimeout(locateTimer.current);
					locateTimer.current = null;
				}
				setTaskCenterOpen(true);
				taskCenterOpenRef.current = true;
				setTaskCenterStatus("loading");
				setTaskCenterError("");
				setTaskCenterSelected(null);

				let pLedger;
				try {
					pLedger = Promise.resolve(remote.taskLedger()).then(unwrap);
					pLedger.catch(() => {});
				} catch (syncErr) {
					if (!isMountedRef.current || taskCenterRequest.current !== generation) return;
					if (intent.quickAccessTaskIntent) {
						const qi = intent.quickAccessTaskIntent;
						const taskKey = `${qi.taskId}:${qi.sourceConversationId}`;
						const tokenValid = taskMembershipTokensRef.current.get(taskKey) === qi.membershipToken &&
							quickAccessTasksRef.current.some((t) => t.taskId === qi.taskId && t.sourceConversationId === qi.sourceConversationId);
						if (!tokenValid) {
							if (!taskCenterOpenRef.current) return;
							setTaskCenterStatus("error");
							setTaskCenterSelected(null);
							setTaskCenterError("快捷引用已失效，导航取消 / Quick access task removed; navigation cancelled");
							return;
						}
					}
					setTaskCenterStatus("error");
					setTaskCenterError(failureText(syncErr));
					return;
				}

				try {
					const ledger = await pLedger;
					if (!isMountedRef.current || taskCenterRequest.current !== generation) return;
					if (intent.quickAccessTaskIntent) {
						const qi = intent.quickAccessTaskIntent;
						const taskKey = `${qi.taskId}:${qi.sourceConversationId}`;
						const tokenValid = taskMembershipTokensRef.current.get(taskKey) === qi.membershipToken &&
							quickAccessTasksRef.current.some((t) => t.taskId === qi.taskId && t.sourceConversationId === qi.sourceConversationId);
						if (!tokenValid) {
							if (!taskCenterOpenRef.current) return;
							setTaskCenterStatus("error");
							setTaskCenterSelected(null);
							setTaskCenterError("快捷引用已失效，导航取消 / Quick access task removed; navigation cancelled");
							return;
						}
					}
					setTaskCenterLedger(ledger);
					if (intent.childValidation) {
						const cv = intent.childValidation;
						const tasks = ledger && Array.isArray(ledger.tasks) ? ledger.tasks : [];
						const matchingChildren = tasks.filter((t) => t.taskId === cv.childTaskId);
						const matchingParents = tasks.filter((t) => t.taskId === cv.parentTaskId);
						const validChild = matchingChildren.length === 1 &&
							matchingChildren[0].sourceConversationId === cv.sourceConversationId &&
							matchingChildren[0].parent?.kind === "task" &&
							matchingChildren[0].parent.taskId === cv.parentTaskId &&
							matchingChildren[0].parent.taskId !== matchingChildren[0].taskId;
						const validParent = matchingParents.length === 1 &&
							matchingParents[0].sourceConversationId === cv.sourceConversationId &&
							matchingParents[0].taskId !== cv.childTaskId;
						if (validChild && validParent) {
							setTaskCenterStatus("ready");
							setTaskCenterSelected(cv.childTaskId);
						} else {
							setTaskCenterStatus("error");
							setTaskCenterSelected(null);
							setTaskCenterError("无法确认子任务关系 / Cannot confirm child task relationship in ledger");
						}
					} else if (intent.parentValidation) {
						const pv = intent.parentValidation;
						const tasks = ledger && Array.isArray(ledger.tasks) ? ledger.tasks : [];
						const matchingChildren = tasks.filter((t) => t.taskId === pv.childTaskId);
						const matchingParents = tasks.filter((t) => t.taskId === pv.parentTaskId);
						const validChild = matchingChildren.length === 1 &&
							matchingChildren[0].sourceConversationId === pv.sourceConversationId &&
							matchingChildren[0].parent?.kind === "task" &&
							matchingChildren[0].parent.taskId === pv.parentTaskId &&
							matchingChildren[0].parent.taskId !== matchingChildren[0].taskId;
						const validParent = matchingParents.length === 1 &&
							matchingParents[0].sourceConversationId === pv.sourceConversationId &&
							matchingParents[0].taskId !== pv.childTaskId;
						if (validChild && validParent) {
							setTaskCenterStatus("ready");
							setTaskCenterSelected(pv.parentTaskId);
						} else {
							setTaskCenterStatus("error");
							setTaskCenterSelected(null);
							setTaskCenterError("无法确认父任务关系 / Cannot confirm parent task relationship in ledger");
						}
					} else {
						const matching = ledger && Array.isArray(ledger.tasks)
							? ledger.tasks.filter((t) => t.taskId === intent.taskId && t.sourceConversationId === intent.sourceConversationId)
							: [];
						if (matching.length === 1) {
							setTaskCenterStatus("ready");
							setTaskCenterSelected(intent.taskId);
						} else {
							setTaskCenterStatus("error");
							setTaskCenterSelected(null);
							setTaskCenterError("无法确认任务目标 / Cannot confirm task target in ledger");
						}
					}
				} catch (error) {
					if (!isMountedRef.current || taskCenterRequest.current !== generation) return;
					if (intent.quickAccessTaskIntent) {
						const qi = intent.quickAccessTaskIntent;
						const taskKey = `${qi.taskId}:${qi.sourceConversationId}`;
						const tokenValid = taskMembershipTokensRef.current.get(taskKey) === qi.membershipToken &&
							quickAccessTasksRef.current.some((t) => t.taskId === qi.taskId && t.sourceConversationId === qi.sourceConversationId);
						if (!tokenValid) {
							if (!taskCenterOpenRef.current) return;
							setTaskCenterStatus("error");
							setTaskCenterSelected(null);
							setTaskCenterError("快捷引用已失效，导航取消 / Quick access task removed; navigation cancelled");
							return;
						}
					}
					setTaskCenterStatus("error");
					setTaskCenterError(failureText(error));
				}
			};
			const viewTaskDetail = async (arg1, arg2) => {
				if (!isMountedRef.current) return;
				let task;
				let context;
				if (arg1 !== null && typeof arg1 === "object" && typeof arg1.taskId === "string") {
					task = arg1;
					context = arg2;
				} else if (arg2 !== null && typeof arg2 === "object" && typeof arg2.taskId === "string") {
					task = arg2;
					context = arg1;
				} else {
					task = arg1;
					context = arg2;
				}
				if (context === undefined || context === null || typeof context !== "object") return;
				const { sourceId, token } = context;
				if (typeof sourceId !== "string" || !sourceId || typeof token !== "number") return;
				if (task === undefined || task === null || typeof task !== "object") return;
				if (typeof task.taskId !== "string" || !task.taskId) return;
				if (taskSourceRef.current !== sourceId || taskToken.current !== token) return;
				if (task.sourceConversationId !== sourceId) return;
				const currentLedger = taskLedgerRef.current;
				if (currentLedger === null || !taskRows(currentLedger, sourceId).some((t) => t.taskId === task.taskId)) return;
				if (!hasLiveTaskSource(sourceId)) return;

				return navigateToTaskDetail({ taskId: task.taskId, sourceConversationId: task.sourceConversationId });
			};
			const viewQuickAccessTaskDetail = async (taskRef) => {
				if (!isMountedRef.current || taskRef === undefined || taskRef === null) return;
				const taskKey = `${taskRef.taskId}:${taskRef.sourceConversationId}`;
				const currentToken = taskMembershipTokensRef.current.get(taskKey);
				if (taskRef.membershipToken === undefined || currentToken === undefined || currentToken !== taskRef.membershipToken) return;
				if (!quickAccessTasksRef.current.some((t) => t.taskId === taskRef.taskId && t.sourceConversationId === taskRef.sourceConversationId)) return;

				return navigateToTaskDetail({
					taskId: taskRef.taskId,
					sourceConversationId: taskRef.sourceConversationId,
					quickAccessTaskIntent: {
						taskId: taskRef.taskId,
						sourceConversationId: taskRef.sourceConversationId,
						membershipToken: taskRef.membershipToken
					}
				});
			};
			const viewParentTaskDetail = async (task, context) => {
				if (!isMountedRef.current) return;
				if (context === null || typeof context !== "object") return;
				const relationViewLifetime = context.relationViewLifetime;
				if (!Number.isSafeInteger(relationViewLifetime) || relationViewLifetime < 0 || relationViewLifetime !== taskCenterRelationViewLifetime.current) return;
				if (!taskCenterOpenRef.current || taskCenterStatusRef.current !== "ready") return;
				if (task === null || task === undefined) return;
				if (taskCenterSelectedRef.current !== task.taskId) return;
				if (!task.parent || task.parent.kind !== "task" || !task.parent.taskId) return;
				if (task.parent.taskId === task.taskId) return;

				const currentLedger = taskCenterLedgerRef.current;
				if (currentLedger === null || !Array.isArray(currentLedger.tasks)) return;

				const matchingChild = currentLedger.tasks.filter((t) => t.taskId === task.taskId);
				if (matchingChild.length !== 1) return;
				const liveChild = matchingChild[0];
				if (liveChild.sourceConversationId !== task.sourceConversationId) return;
				if (!liveChild.parent || liveChild.parent.kind !== "task" || liveChild.parent.taskId !== task.parent.taskId) return;

				const matchingParent = currentLedger.tasks.filter((t) => t.taskId === liveChild.parent.taskId);
				if (matchingParent.length !== 1) return;
				if (matchingParent[0].sourceConversationId !== task.sourceConversationId) return;
				if (matchingParent[0].taskId === liveChild.taskId) return;

				const intent = {
					taskId: liveChild.parent.taskId,
					sourceConversationId: task.sourceConversationId,
					parentValidation: {
						childTaskId: liveChild.taskId,
						parentTaskId: liveChild.parent.taskId,
						sourceConversationId: task.sourceConversationId
					}
				};

				return navigateToTaskDetail(intent);
			};
			const viewChildTaskDetail = async (parentTask, childTask, context) => {
				if (!isMountedRef.current) return;
				if (context === null || typeof context !== "object") return;
				const relationViewLifetime = context.relationViewLifetime;
				if (!Number.isSafeInteger(relationViewLifetime) || relationViewLifetime < 0 || relationViewLifetime !== taskCenterRelationViewLifetime.current) return;
				if (!taskCenterOpenRef.current || taskCenterStatusRef.current !== "ready") return;
				if (parentTask === null || parentTask === undefined || childTask === null || childTask === undefined) return;
				if (taskCenterSelectedRef.current !== parentTask.taskId) return;
				if (parentTask.taskId === childTask.taskId) return;
				if (parentTask.sourceConversationId !== childTask.sourceConversationId) return;

				const currentLedger = taskCenterLedgerRef.current;
				if (currentLedger === null || !Array.isArray(currentLedger.tasks)) return;

				const matchingParents = currentLedger.tasks.filter((t) => t.taskId === parentTask.taskId);
				if (matchingParents.length !== 1) return;
				const liveParent = matchingParents[0];
				if (liveParent.sourceConversationId !== parentTask.sourceConversationId) return;

				const matchingChildren = currentLedger.tasks.filter((t) => t.taskId === childTask.taskId);
				if (matchingChildren.length !== 1) return;
				const liveChild = matchingChildren[0];
				if (liveChild.sourceConversationId !== parentTask.sourceConversationId) return;
				if (!liveChild.parent || liveChild.parent.kind !== "task" || liveChild.parent.taskId !== parentTask.taskId) return;
				if (liveChild.taskId === liveChild.parent.taskId) return;

				const intent = {
					taskId: liveChild.taskId,
					sourceConversationId: parentTask.sourceConversationId,
					childValidation: {
						childTaskId: liveChild.taskId,
						parentTaskId: liveParent.taskId,
						sourceConversationId: parentTask.sourceConversationId
					}
				};

				return navigateToTaskDetail(intent);
			};
			const toggleTasks = (node) => {
				if (!isMountedRef.current) return;
				const sourceId = typeof node === "object" && node !== null ? node.id : node;
				if (!sourceId) return;
				if (taskSourceRef.current === sourceId) {
					taskToken.current += 1;
					taskRequest.current += 1;
					taskSourceRef.current = null;
					setTaskSource(null);
					setTaskLedger(null);
					taskLedgerRef.current = null;
					setTaskStatus("idle");
					taskStatusRef.current = "idle";
					setTaskError("");
					return;
				}
				const activeSnapshot = snapshotRef.current;
				if (snapshotStaleRef.current || activeSnapshot === null || !Array.isArray(activeSnapshot.nodes)) return;
				const matchingSources = activeSnapshot.nodes.filter((candidate) => candidate.id === sourceId);
				if (matchingSources.length !== 1 || matchingSources[0].kind !== "conversation") return;
				const nextToken = taskToken.current + 1;
				taskToken.current = nextToken;
				taskRequest.current += 1;
				taskSourceRef.current = sourceId;
				setTaskSource(sourceId);
				setTaskLedger(null);
				taskLedgerRef.current = null;
				setTaskStatus("loading");
				taskStatusRef.current = "loading";
				setTaskError("");
				void loadTasks(sourceId, nextToken);
			};
			const refreshTasks = async (context) => {
				if (!isMountedRef.current) return;
				if (context === undefined || context === null) return;
				const { sourceId, token } = context;
				if (!sourceId || taskSourceRef.current !== sourceId || taskToken.current !== token) return;
				if (taskStatusRef.current === "loading" || busy) return;
				if (!hasLiveTaskSource(sourceId)) return;

				const generation = taskRequest.current + 1;
				taskRequest.current = generation;
				setTaskStatus("loading");
				taskStatusRef.current = "loading";
				setTaskError("");
				let pReconcile;
				try {
					pReconcile = Promise.resolve(remote.reconcileTasks({ conversationId: sourceId })).then(unwrap);
					pReconcile.catch(() => {});
				} catch (syncErr) {
					if (!isMountedRef.current || taskRequest.current !== generation || taskSourceRef.current !== sourceId || taskToken.current !== token) return;
					const fallbackStatus = taskLedgerRef.current === null ? "error" : "stale";
					setTaskStatus(fallbackStatus);
					taskStatusRef.current = fallbackStatus;
					setTaskError(failureText(syncErr));
					return;
				}
				try {
					const result = await pReconcile;
					if (!isMountedRef.current || taskRequest.current !== generation || taskSourceRef.current !== sourceId || taskToken.current !== token) return;
					const sourceRecord = result && result.ledger && Array.isArray(result.ledger.sources)
						? result.ledger.sources.find((entry) => entry.conversationId === sourceId)
						: null;
					const nextStatus = sourceRecord?.verificationState === "blocked" ? "stale" : "loaded";
					setTaskLedger(result.ledger);
					taskLedgerRef.current = result.ledger;
					setTaskStatus(nextStatus);
					taskStatusRef.current = nextStatus;
				} catch (error) {
					if (!isMountedRef.current || taskRequest.current !== generation || taskSourceRef.current !== sourceId || taskToken.current !== token) return;
					setTaskError(failureText(error));
					const nextStatus = taskLedgerRef.current === null ? "error" : "stale";
					setTaskStatus(nextStatus);
					taskStatusRef.current = nextStatus;
				}
			};

			const rows = snapshot === null ? [] : buildRows(snapshot.nodes).flatMap(function walk(row) {
				return [row].concat(row.children.flatMap(walk));
			});
			const hidden = new Set();
			const visibleRows = rows.filter(function (row) {
				if (row.node.parentId !== null && hidden.has(row.node.parentId)) {
					hidden.add(row.node.id);
					return false;
				}
				if (row.node.kind === "project" && collapsed.has(row.node.id)) hidden.add(row.node.id);
				return true;
			});

			const cancelCreateProject = (context) => {
				if (!isMountedRef.current) return;
				if (createProjectSubmittingRef.current) return;
				if (context && (createProjectParentRef.current === null || createProjectParentRef.current.id !== context.parentId || createProjectToken.current !== context.token)) return;
				createProjectToken.current += 1;
				createProjectParentRef.current = null;
				createProjectDraftRef.current = "";
				createProjectUnconfirmedRef.current = false;
				createProjectRequest.current += 1;
				setCreateProjectActive(false);
				setCreateProjectParent(null);
				setCreateProjectDraft("");
				setCreateProjectError("");
				setCreateProjectUnconfirmed(false);
			};

			const handleCreateProjectInput = (event, context) => {
				if (!isMountedRef.current) return;
				if (createProjectSubmittingRef.current) return;
				if (!context || createProjectParentRef.current === null || createProjectParentRef.current.id !== context.parentId || createProjectToken.current !== context.token) return;
				const nextVal = (event && event.target && typeof event.target.value === "string")
					? event.target.value
					: (typeof event === "string" ? event : "");
				createProjectDraftRef.current = nextVal;
				setCreateProjectDraft(nextVal);
			};

			const startCreateProject = (explicitNode) => {
				if (!isMountedRef.current) return;
				if (createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current) return;
				if (createProjectActive || createProjectParentRef.current !== null) {
					return;
				}
				if (linkWorkspaceActive) {
					const msg = "正在关联工作区中，请先完成或取消关联 / Workspace linking in progress; please finish or cancel first";
					setNotice(msg);
					setCreateProjectError(msg);
					return;
				}
				if (linkSessionActive) {
					const msg = "正在关联会话中，请先完成或取消关联 / Session linking in progress; please finish or cancel first";
					setNotice(msg);
					setCreateProjectError(msg);
					return;
				}
				if (renameSubmittingRef.current || renameTarget !== null) {
					const msg = "正在重命名中，请先保存或取消重命名 / Rename in progress; please finish or cancel first";
					setNotice(msg);
					setCreateProjectError(msg);
					return;
				}
				if (moveSubmittingRef.current || movePreviewRef.current !== null) {
					const msg = "正在移动中，请先确认或取消移动 / Move in progress; please finish or cancel first";
					setNotice(msg);
					setCreateProjectError(msg);
					return;
				}
				if (snapshot === null) {
					const msg = "快照未就绪，无法创建项目 / Snapshot is not available";
					setNotice(msg);
					setCreateProjectError(msg);
					return;
				}
				if (snapshotStale) {
					const msg = "快照已陈旧失效，拒绝创建 / Snapshot is stale; creation refused";
					setNotice(msg);
					setCreateProjectError(msg);
					return;
				}

				let parentObj = null;
				if (explicitNode !== undefined && explicitNode !== null) {
					if (explicitNode.kind !== "project") {
						const msg = "仅支持在项目下创建子项目 / Projects can only be created under a project";
						setNotice(msg);
						setCreateProjectError(msg);
						return;
					}
					if (!validateAncestorChain(explicitNode, snapshot)) {
						const msg = "祖先链无效或存在循环，无法创建 / Invalid or cyclic ancestor chain; create refused";
						setNotice(msg);
						setCreateProjectError(msg);
						return;
					}
					parentObj = { id: explicitNode.id, title: explicitNode.title, path: pathOf(explicitNode) };
				} else if (selected === null || selected === undefined) {
					const rootId = snapshot.rootId || "root";
					const rootNode = snapshot.nodes.find((n) => n.id === rootId);
					parentObj = {
						id: rootId,
						title: rootNode ? rootNode.title : "Root",
						path: rootNode ? pathOf(rootNode) : "Root"
					};
				} else {
					if (selectedNode === undefined) {
						const msg = "选中的父节点在快照中不存在，无法创建 / Selected parent node not found in snapshot";
						setNotice(msg);
						setCreateProjectError(msg);
						return;
					}
					if (selectedNode.kind !== "project") {
						const msg = "仅支持在项目下创建子项目 / Projects can only be created under a project";
						setNotice(msg);
						setCreateProjectError(msg);
						return;
					}
					if (!validateAncestorChain(selectedNode, snapshot)) {
						const msg = "祖先链无效或存在循环，无法创建 / Invalid or cyclic ancestor chain; create refused";
						setNotice(msg);
						setCreateProjectError(msg);
						return;
					}
					parentObj = { id: selectedNode.id, title: selectedNode.title, path: pathOf(selectedNode) };
				}

				createProjectToken.current += 1;
				createProjectUnconfirmedRef.current = false;
				setCreateProjectParent(parentObj);
				createProjectParentRef.current = parentObj;
				const initialDraft = title.trim();
				setCreateProjectDraft(initialDraft);
				createProjectDraftRef.current = initialDraft;
				setCreateProjectError("");
				setCreateProjectUnconfirmed(false);
				setCreateProjectActive(true);
			};

			const confirmCreateProject = async (context) => {
				if (!isMountedRef.current) return;
				if (createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current) return;
				if (renameSubmittingRef.current || moveSubmittingRef.current || linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current) return;

				if (!createProjectActive || createProjectParentRef.current === null) return;
				if (!context || createProjectParentRef.current.id !== context.parentId || createProjectToken.current !== context.token) return;
				const parent = createProjectParentRef.current;

				if (createProjectUnconfirmedRef.current || createProjectUnconfirmed) {
					const msg = "传输结果未知，结果未确认，禁止重复提交；请取消或核实 / Result unconfirmed; duplicate submission prohibited";
					setCreateProjectError(msg);
					setNotice(msg);
					return;
				}

				if (snapshot === null) {
					setCreateProjectError("快照未就绪，无法创建项目 / Snapshot is not available");
					return;
				}
				if (snapshotStale) {
					setCreateProjectError("快照已陈旧失效，拒绝创建 / Snapshot is stale; creation refused");
					return;
				}

				const parentEl = typeof document === "undefined" ? null : document.querySelector("[data-wo-create-project-parent]");
				if (parentEl !== null) {
					const domParentId = parentEl.getAttribute("data-wo-create-project-parent");
					if (domParentId !== null && domParentId !== parent.id) {
						setCreateProjectError("创建目标与DOM不一致 / Target mismatch");
						return;
					}
				}

				const isRootParent = parent.id === "root" || (snapshot.rootId !== undefined && parent.id === snapshot.rootId);
				let parentNode = snapshot.nodes.find((n) => n.id === parent.id);
				if (parentNode === undefined && isRootParent) {
					parentNode = {
						id: snapshot.rootId || "root",
						kind: "project",
						title: "Root",
						parentId: null
					};
				}
				if (parentNode === undefined) {
					setCreateProjectError("父项目在当前快照中不存在 / Parent project not found in snapshot");
					return;
				}
				if (parentNode.kind !== "project") {
					setCreateProjectError("父节点必须为项目 / Parent must be a project");
					return;
				}
				if (!validateAncestorChain(parentNode, snapshot)) {
					setCreateProjectError("祖先链无效或存在循环，无法创建 / Invalid or cyclic ancestor chain; create refused");
					return;
				}

				const input = typeof document === "undefined" ? null : document.querySelector("[data-wo-create-project-input]");
				const rawName = input !== null && typeof input.value === "string" ? input.value : createProjectDraftRef.current;
				const name = rawName.trim();

				if (name.length === 0 || name.length > 200) {
					setCreateProjectError("Name must be 1–200 characters");
					return;
				}

				createProjectSubmittingRef.current = true;
				setCreateProjectSubmitting(true);
				setCreateProjectError("");
				setBusy(true);

				refreshRequest.current += 1;
				const generation = createProjectRequest.current + 1;
				createProjectRequest.current = generation;

				try {
					const nextSnapshot = await remote.createProject({ parentId: parent.id, title: name }).then(unwrap);
					if (!isMountedRef.current || createProjectRequest.current !== generation) return;

					createProjectToken.current += 1;
					createProjectParentRef.current = null;
					createProjectDraftRef.current = "";
					createProjectUnconfirmedRef.current = false;

					setSnapshot(nextSnapshot);
					setSnapshotStale(false);
					setNotice("项目创建已确认 / Project created");
					setCreateProjectActive(false);
					setCreateProjectParent(null);
					setCreateProjectDraft("");
					setCreateProjectError("");
					setCreateProjectUnconfirmed(false);
					createProjectSubmittingRef.current = false;
					setCreateProjectSubmitting(false);
					setTitle("");
					setCreatePanelOpen(false);

					try {
						const [reloadedSnapshot, reportedStatus] = await Promise.all([
							remote.snapshot().then(unwrap),
							remote.status().then(unwrap)
						]);
						if (!isMountedRef.current || createProjectRequest.current !== generation) return;
						setSnapshot(reloadedSnapshot);
						setStatus(reportedStatus);
						setSnapshotStale(false);
					} catch (refreshErr) {
						if (!isMountedRef.current || createProjectRequest.current !== generation) return;
						setSnapshotStale(true);
						setNotice("项目创建已确认；但后续快照刷新失败，显示最后确认快照 / Project created; subsequent refresh failed: " + failureText(refreshErr));
					}
				} catch (error) {
					if (!isMountedRef.current || createProjectRequest.current !== generation) return;
					createProjectUnconfirmedRef.current = true;
					createProjectSubmittingRef.current = false;
					setCreateProjectSubmitting(false);
					const msg = failureText(error);
					setCreateProjectError(msg);
					setCreateProjectUnconfirmed(true);
					setNotice("传输结果未知或创建失败，结果未确认，勿重复创建 / Result unconfirmed or failed: " + msg);
				} finally {
					if (createProjectRequest.current === generation) {
						createProjectSubmittingRef.current = false;
						setCreateProjectSubmitting(false);
						setBusy(false);
					}
				}
			};

			const addProject = () => {
				startCreateProject();
			};

			const triggerPanelRename = () => {
				if (selectedNode === undefined || renameSubmittingRef.current || moveSubmittingRef.current || createProjectSubmittingRef.current || createProjectActive || linkWorkspaceSubmittingRef.current || linkWorkspaceActive || linkSessionSubmittingRef.current || linkSessionActive) return;
				if (selectedNode.kind === "project" && selectedNode.parentId === null) return;
				startRename(selectedNode);
				if (title.trim().length > 0) {
					setRenameDraft(title.trim());
					setTitle("");
				}
			};

			const resolveConversationReason = (stat) => {
				if (!stat || typeof stat !== "object") return "未提供 (Not provided)";
				const structured = stat.conversationCreation;
				if (structured && typeof structured === "object" && typeof structured.reason === "string" && structured.reason.trim().length > 0) {
					return structured.reason.trim();
				}
				if (typeof stat.sessionSource === "string" && stat.sessionSource.trim().length > 0) {
					return stat.sessionSource.trim();
				}
				return "未提供 (Not provided)";
			};

			const evaluateConversationCapability = (stat, isStale) => {
				if (stat === null || stat === undefined || typeof stat !== "object") {
					return {
						allowed: false,
						state: "unverified",
						notice: "普通会话能力尚未验证 (Capability unverified)",
						reason: "能力尚未验证 (Capability unverified)"
					};
				}

				const creatable = stat.conversationsCreatable;
				if (typeof creatable !== "boolean") {
					return {
						allowed: false,
						state: "unverified",
						notice: "普通会话能力尚未验证 (Capability unverified)",
						reason: "能力尚未验证 (Capability unverified)"
					};
				}

				if (stat.conversationCreation && typeof stat.conversationCreation === "object") {
					const structSupported = stat.conversationCreation.supported;
					if (structSupported !== undefined && (typeof structSupported !== "boolean" || structSupported !== creatable)) {
						return {
							allowed: false,
							state: "unverified",
							notice: "普通会话能力尚未验证 (Capability unverified: conflicting capability flags)",
							reason: "能力尚未验证 (Capability unverified: conflicting capability flags)"
						};
					}
				}

				if (isStale) {
					const reason = resolveConversationReason(stat);
					return {
						allowed: false,
						state: "stale",
						notice: `普通会话状态: 最后已知状态，刷新失败 (Last known state; refresh failed): ${reason}`,
						reason: reason
					};
				}

				if (creatable === true) {
					return {
						allowed: true,
						state: "supported",
						notice: "普通会话可用 (Conversations available)",
						reason: null
					};
				}

				const reason = resolveConversationReason(stat);
				return {
					allowed: false,
					state: "unsupported",
					notice: `普通会话当前不支持: ${reason} (Currently unsupported)`,
					reason: reason
				};
			};

			const addConversation = () => {
				if (!isMountedRef.current) return;
				if (busy || renameSubmittingRef.current || moveSubmittingRef.current || createProjectSubmittingRef.current || createProjectActive || linkWorkspaceSubmittingRef.current || linkWorkspaceActive || linkSessionSubmittingRef.current || linkSessionActive) {
					return;
				}
				const liveSnapshot = snapshotRef.current;
				const liveStatus = statusRef.current;
				const liveStale = snapshotStaleRef.current;
				if (liveStale || liveSnapshot === null || liveStatus === null) {
					return;
				}
				const cap = evaluateConversationCapability(liveStatus, liveStale);
				if (!cap.allowed) {
					return;
				}
				const currentTitle = titleRef.current.trim();
				if (currentTitle.length === 0) return;
				const currentSelectedId = selectedRef.current;
				const currentSelectedNode = currentSelectedId === null
					? undefined
					: liveSnapshot.nodes.find((node) => node.id === currentSelectedId);
				const currentParentId = currentSelectedNode === undefined
					? liveSnapshot.rootId
					: (currentSelectedNode.kind === "project" ? currentSelectedNode.id : undefined);
				if (currentParentId === undefined) return;

				return run(async () => {
					await remote.createConversation({ parentId: currentParentId, title: currentTitle }).then(unwrap);
					setTitle("");
					setCreatePanelOpen(false);
				});
			};

			const cancelLinkWorkspace = (context) => {
				if (!isMountedRef.current) return;
				if (context && (linkWorkspaceParentRef.current === null || linkWorkspaceParentRef.current.id !== context.parentId || linkWorkspaceToken.current !== context.token)) return;
				if (linkWorkspaceSubmittingRef.current) return;
				linkWorkspaceToken.current += 1;
				linkWorkspaceRequest.current += 1;
				setLinkWorkspaceActive(false);
				setLinkWorkspaceParent(null);
				linkWorkspaceParentRef.current = null;
				setLinkWorkspaceDraftTitle("");
				linkWorkspaceDraftTitleRef.current = "";
				setLinkWorkspaceDraftDirectory("");
				linkWorkspaceDraftDirectoryRef.current = "";
				setLinkWorkspaceError("");
				linkWorkspaceUnconfirmedRef.current = false;
				setLinkWorkspaceUnconfirmed(false);
			};

			const handleLinkWorkspaceTitleInput = (event, context) => {
				if (!isMountedRef.current) return;
				if (!context || linkWorkspaceParentRef.current === null || linkWorkspaceParentRef.current.id !== context.parentId || linkWorkspaceToken.current !== context.token) return;
				const nextVal = event && event.target ? event.target.value : "";
				setLinkWorkspaceDraftTitle(nextVal);
				linkWorkspaceDraftTitleRef.current = nextVal;
			};

			const handleLinkWorkspaceDirectoryInput = (event, context) => {
				if (!isMountedRef.current) return;
				if (!context || linkWorkspaceParentRef.current === null || linkWorkspaceParentRef.current.id !== context.parentId || linkWorkspaceToken.current !== context.token) return;
				const nextVal = event && event.target ? event.target.value : "";
				setLinkWorkspaceDraftDirectory(nextVal);
				linkWorkspaceDraftDirectoryRef.current = nextVal;
			};

			const startLinkWorkspace = (explicitNode) => {
				if (!isMountedRef.current) return;
				if (linkWorkspaceActive || linkWorkspaceParentRef.current !== null) return;
				if (linkWorkspaceSubmittingRef.current || createProjectSubmittingRef.current || linkSessionSubmittingRef.current) return;
				if (createProjectActive) {
					const msg = "正在创建项目中，请先完成或取消创建 / Project creation in progress; please finish or cancel first";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}
				if (linkSessionActive) {
					const msg = "正在关联会话中，请先完成或取消关联 / Session linking in progress; please finish or cancel first";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}
				if (renameSubmittingRef.current || renameTarget !== null) {
					const msg = "正在重命名中，请先保存或取消重命名 / Rename in progress; please finish or cancel first";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}
				if (moveSubmittingRef.current || movePreviewRef.current !== null) {
					const msg = "正在移动中，请先确认或取消移动 / Move in progress; please finish or cancel first";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}
				if (snapshot === null) {
					const msg = "快照未就绪，无法关联工作区 / Snapshot is not available";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}
				if (snapshotStale) {
					const msg = "快照已陈旧失效，拒绝关联 / Snapshot is stale; linking refused";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}

				let targetNode = explicitNode;
				if (targetNode === undefined || targetNode === null) {
					if (selected === null || selected === undefined) {
						const msg = "未选择父项目，仅支持在嵌套项目下关联工作区 / No project selected; workspaces can only be linked under a nested project";
						setNotice(msg);
						setLinkWorkspaceError(msg);
						return;
					}
					targetNode = selectedNode;
				}

				if (targetNode === undefined || targetNode === null) {
					const msg = "选中的父节点在快照中不存在，无法关联 / Selected parent node not found in snapshot";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}

				if (targetNode.id === snapshot.rootId || targetNode.parentId === null) {
					const msg = "禁止在根项目下直接关联工作区，仅支持在嵌套项目下关联 / Workspaces cannot be linked directly under Root; select a nested project";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}

				if (targetNode.kind !== "project") {
					const msg = "仅支持在项目下关联工作区 / Workspaces can only be linked under a project";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}

				if (!validateAncestorChain(targetNode, snapshot)) {
					const msg = "祖先链无效或存在循环，无法关联 / Invalid or cyclic ancestor chain; link refused";
					setNotice(msg);
					setLinkWorkspaceError(msg);
					return;
				}

				linkWorkspaceToken.current += 1;
				const parentObj = { id: targetNode.id, title: targetNode.title, path: pathOf(targetNode) };
				setLinkWorkspaceParent(parentObj);
				linkWorkspaceParentRef.current = parentObj;

				setLinkWorkspaceDraftTitle("");
				linkWorkspaceDraftTitleRef.current = "";
				setLinkWorkspaceDraftDirectory("");
				linkWorkspaceDraftDirectoryRef.current = "";
				setLinkWorkspaceError("");
				linkWorkspaceUnconfirmedRef.current = false;
				setLinkWorkspaceUnconfirmed(false);
				setLinkWorkspaceActive(true);
			};

			const confirmLinkWorkspace = async (context) => {
				if (!isMountedRef.current) return;
				if (!context || linkWorkspaceParentRef.current === null || linkWorkspaceParentRef.current.id !== context.parentId || linkWorkspaceToken.current !== context.token) return;
				if (linkWorkspaceSubmittingRef.current || linkSessionSubmittingRef.current) return;
				if (renameSubmittingRef.current || moveSubmittingRef.current || createProjectSubmittingRef.current || linkSessionSubmittingRef.current) return;

				if (!linkWorkspaceActive || linkWorkspaceParentRef.current === null) return;
				const parent = linkWorkspaceParentRef.current;

				if (linkWorkspaceUnconfirmedRef.current || linkWorkspaceUnconfirmed) {
					const msg = "传输结果未知，结果未确认，禁止重复提交；请取消或核实 / Result unconfirmed; duplicate submission prohibited";
					setLinkWorkspaceError(msg);
					setNotice(msg);
					return;
				}

				if (snapshot === null) {
					setLinkWorkspaceError("快照未就绪，无法关联工作区 / Snapshot is not available");
					return;
				}
				if (snapshotStale) {
					setLinkWorkspaceError("快照已陈旧失效，拒绝关联 / Snapshot is stale; linking refused");
					return;
				}

				const parentEl = typeof document === "undefined" ? null : document.querySelector("[data-wo-link-workspace-parent]");
				if (parentEl !== null) {
					const domParentId = parentEl.getAttribute("data-wo-link-workspace-parent");
					if (domParentId !== null && domParentId !== parent.id) {
						setLinkWorkspaceError("创建目标与DOM不一致 / Target mismatch");
						return;
					}
				}

				if (parent.id === "root" || (snapshot.rootId !== undefined && parent.id === snapshot.rootId)) {
					setLinkWorkspaceError("禁止在根项目下关联工作区 / Workspaces cannot be linked under Root");
					return;
				}

				let parentNode = snapshot.nodes.find((n) => n.id === parent.id);
				if (parentNode === undefined) {
					setLinkWorkspaceError("父项目在当前快照中不存在 / Parent project not found in snapshot");
					return;
				}
				if (parentNode.kind !== "project" || parentNode.parentId === null) {
					setLinkWorkspaceError("父节点必须为嵌套项目 / Parent must be a nested project");
					return;
				}
				if (!validateAncestorChain(parentNode, snapshot)) {
					setLinkWorkspaceError("祖先链无效或存在循环，无法关联 / Invalid or cyclic ancestor chain; link refused");
					return;
				}

				const titleInput = typeof document === "undefined" ? null : document.querySelector("[data-wo-link-workspace-title-input]");
				const rawTitle = titleInput !== null && typeof titleInput.value === "string" ? titleInput.value : linkWorkspaceDraftTitleRef.current;
				const name = rawTitle.trim();

				const dirInput = typeof document === "undefined" ? null : document.querySelector("[data-wo-link-workspace-dir-input]");
				const rawDir = dirInput !== null && typeof dirInput.value === "string" ? dirInput.value : linkWorkspaceDraftDirectoryRef.current;
				const path = rawDir.trim();

				if (name.length === 0 || name.length > 200) {
					setLinkWorkspaceError("Name must be 1–200 characters");
					return;
				}
				if (path.length === 0) {
					setLinkWorkspaceError("Directory must not be empty");
					return;
				}

				linkWorkspaceSubmittingRef.current = true;
				setLinkWorkspaceSubmitting(true);
				setLinkWorkspaceError("");
				setBusy(true);

				refreshRequest.current += 1;
				const generation = linkWorkspaceRequest.current + 1;
				linkWorkspaceRequest.current = generation;

				try {
					const nextSnapshot = await remote.registerWorkspace({ parentId: parent.id, title: name, directory: path }).then(unwrap);
					if (!isMountedRef.current || linkWorkspaceRequest.current !== generation) return;

					setSnapshot(nextSnapshot);
					setSnapshotStale(false);
					setNotice("工作区关联已确认 / Workspace linked");
					linkWorkspaceToken.current += 1;
					setLinkWorkspaceActive(false);
					setLinkWorkspaceParent(null);
					linkWorkspaceParentRef.current = null;
					setLinkWorkspaceDraftTitle("");
					linkWorkspaceDraftTitleRef.current = "";
					setLinkWorkspaceDraftDirectory("");
					linkWorkspaceDraftDirectoryRef.current = "";
					setLinkWorkspaceError("");
					linkWorkspaceUnconfirmedRef.current = false;
					setLinkWorkspaceUnconfirmed(false);
					linkWorkspaceSubmittingRef.current = false;
					setLinkWorkspaceSubmitting(false);
					setTitle("");
					setDirectory("");
					setCreatePanelOpen(false);

					try {
						const [reloadedSnapshot, reportedStatus] = await Promise.all([
							remote.snapshot().then(unwrap),
							remote.status().then(unwrap)
						]);
						if (!isMountedRef.current || linkWorkspaceRequest.current !== generation) return;
						setSnapshot(reloadedSnapshot);
						setStatus(reportedStatus);
						setSnapshotStale(false);
					} catch (refreshErr) {
						if (!isMountedRef.current || linkWorkspaceRequest.current !== generation) return;
						setSnapshotStale(true);
						setNotice("工作区关联已确认；但后续快照刷新失败，显示最后确认快照 / Workspace linked; subsequent refresh failed: " + failureText(refreshErr));
					}
				} catch (error) {
					if (!isMountedRef.current || linkWorkspaceRequest.current !== generation) return;
					linkWorkspaceUnconfirmedRef.current = true;
					linkWorkspaceSubmittingRef.current = false;
					setLinkWorkspaceSubmitting(false);
					const msg = failureText(error);
					setLinkWorkspaceError(msg);
					setLinkWorkspaceUnconfirmed(true);
					setNotice("传输结果未知或关联失败，结果未确认，勿重复关联 / Result unconfirmed or failed: " + msg);
				} finally {
					if (isMountedRef.current && linkWorkspaceRequest.current === generation) {
						linkWorkspaceSubmittingRef.current = false;
						setLinkWorkspaceSubmitting(false);
						setBusy(false);
					}
				}
			};

			const linkWorkspace = () => {
				startLinkWorkspace();
			};

			const cancelLinkSession = (context) => {
				if (!isMountedRef.current) return;
				if (linkSessionSubmittingRef.current) return;
				if (context && (linkSessionWorkspaceRef.current === null || linkSessionWorkspaceRef.current.id !== context.workspaceId || linkSessionToken.current !== context.token)) return;
				linkSessionToken.current += 1;
				linkSessionWorkspaceRef.current = null;
				linkSessionDraftTitleRef.current = "";
				linkSessionDraftSessionIdRef.current = "";
				linkSessionUnconfirmedRef.current = false;
				linkSessionRequest.current += 1;
				setLinkSessionActive(false);
				setLinkSessionWorkspace(null);
				setLinkSessionDraftTitle("");
				setLinkSessionDraftSessionId("");
				setLinkSessionError("");
				setLinkSessionUnconfirmed(false);
			};

			const handleLinkSessionTitleInput = (event, context) => {
				if (!isMountedRef.current) return;
				if (linkSessionSubmittingRef.current) return;
				if (!context || linkSessionWorkspaceRef.current === null || linkSessionWorkspaceRef.current.id !== context.workspaceId || linkSessionToken.current !== context.token) return;
				const nextVal = (event && event.target && typeof event.target.value === "string")
					? event.target.value
					: (typeof event === "string" ? event : "");
				linkSessionDraftTitleRef.current = nextVal;
				setLinkSessionDraftTitle(nextVal);
			};

			const handleLinkSessionIdInput = (event, context) => {
				if (!isMountedRef.current) return;
				if (linkSessionSubmittingRef.current) return;
				if (!context || linkSessionWorkspaceRef.current === null || linkSessionWorkspaceRef.current.id !== context.workspaceId || linkSessionToken.current !== context.token) return;
				const nextVal = (event && event.target && typeof event.target.value === "string")
					? event.target.value
					: (typeof event === "string" ? event : "");
				linkSessionDraftSessionIdRef.current = nextVal;
				setLinkSessionDraftSessionId(nextVal);
			};

			const startLinkSession = (explicitNode) => {
				if (!isMountedRef.current) return;
				if (linkSessionSubmittingRef.current || createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current) return;
				if (linkSessionActive || linkSessionWorkspaceRef.current !== null) {
					return;
				}
				if (createProjectActive) {
					const msg = "正在创建项目中，请先完成或取消创建 / Project creation in progress; please finish or cancel first";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}
				if (renameSubmittingRef.current || renameTarget !== null) {
					const msg = "正在重命名中，请先保存或取消重命名 / Rename in progress; please finish or cancel first";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}
				if (moveSubmittingRef.current || movePreviewRef.current !== null) {
					const msg = "正在移动中，请先确认或取消移动 / Move in progress; please finish or cancel first";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}
				if (linkWorkspaceActive || linkWorkspaceSubmittingRef.current) {
					const msg = "正在关联工作区中，请先完成或取消关联 / Workspace linking in progress; please finish or cancel first";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}
				if (snapshot === null) {
					const msg = "快照未就绪，无法关联会话 / Snapshot is not available";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}
				if (snapshotStale) {
					const msg = "快照已陈旧失效，拒绝关联 / Snapshot is stale; linking refused";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}

				let targetNode = explicitNode;
				if (targetNode === undefined || targetNode === null) {
					if (selected === null || selected === undefined) {
						const msg = "未选择工作区，仅支持在已有工作区下关联会话 / No workspace selected; sessions can only be linked under an existing workspace";
						setNotice(msg);
						setLinkSessionError(msg);
						return;
					}
					targetNode = selectedNode;
				}

				if (targetNode === undefined || targetNode === null) {
					const msg = "选中的工作区在快照中不存在，无法关联 / Selected workspace node not found in snapshot";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}

				if (targetNode.id === snapshot.rootId || targetNode.parentId === null) {
					const msg = "根项目禁止关联会话 / Sessions cannot be linked under Root";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}

				if (targetNode.kind !== "workspace") {
					const msg = "仅支持在工作区下关联会话 / Sessions can only be linked under a workspace";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}

				if (!validateAncestorChain(targetNode, snapshot)) {
					const msg = "祖先链无效或存在循环，无法关联 / Invalid or cyclic ancestor chain; link refused";
					setNotice(msg);
					setLinkSessionError(msg);
					return;
				}

				const wsObj = {
					id: targetNode.id,
					title: targetNode.title,
					path: pathOf(targetNode),
					directory: targetNode.directory ?? "",
					nativeWorkspaceId: targetNode.nativeWorkspaceId ?? ""
				};

				linkSessionToken.current += 1;
				linkSessionUnconfirmedRef.current = false;
				setLinkSessionWorkspace(wsObj);
				linkSessionWorkspaceRef.current = wsObj;

				const initialSessionId = sessionId.trim();
				setLinkSessionDraftTitle("");
				linkSessionDraftTitleRef.current = "";
				setLinkSessionDraftSessionId(initialSessionId);
				linkSessionDraftSessionIdRef.current = initialSessionId;
				setLinkSessionError("");
				setLinkSessionUnconfirmed(false);
				setLinkSessionActive(true);
			};

			const confirmLinkSession = async (context) => {
				if (!isMountedRef.current) return;
				if (linkSessionSubmittingRef.current) return;
				if (renameSubmittingRef.current || moveSubmittingRef.current || createProjectSubmittingRef.current || linkWorkspaceSubmittingRef.current) return;

				if (!linkSessionActive || linkSessionWorkspaceRef.current === null) return;
				if (!context || linkSessionWorkspaceRef.current.id !== context.workspaceId || linkSessionToken.current !== context.token) return;
				const ws = linkSessionWorkspaceRef.current;

				if (linkSessionUnconfirmedRef.current || linkSessionUnconfirmed) {
					const msg = "传输结果未知，结果未确认，禁止重复提交；请取消或核实 / Result unconfirmed; duplicate submission prohibited";
					setLinkSessionError(msg);
					setNotice(msg);
					return;
				}

				if (snapshot === null) {
					setLinkSessionError("快照未就绪，无法关联会话 / Snapshot is not available");
					return;
				}
				if (snapshotStale) {
					setLinkSessionError("快照已陈旧失效，拒绝关联 / Snapshot is stale; linking refused");
					return;
				}

				const wsEl = typeof document === "undefined" ? null : document.querySelector("[data-wo-link-session-workspace]");
				if (wsEl !== null) {
					const domWsId = wsEl.getAttribute("data-wo-link-session-workspace");
					if (domWsId !== null && domWsId !== ws.id) {
						setLinkSessionError("创建目标与DOM不一致 / Target mismatch");
						return;
					}
				}

				let wsNode = snapshot.nodes.find((n) => n.id === ws.id);
				if (wsNode === undefined) {
					setLinkSessionError("目标工作区在当前快照中不存在 / Target workspace not found in snapshot");
					return;
				}
				if (wsNode.kind !== "workspace" || wsNode.parentId === null) {
					setLinkSessionError("目标节点必须为工作区 / Target must be a workspace");
					return;
				}
				if (!validateAncestorChain(wsNode, snapshot)) {
					setLinkSessionError("祖先链无效或存在循环，无法关联 / Invalid or cyclic ancestor chain; link refused");
					return;
				}
				if ((ws.directory && wsNode.directory && ws.directory !== wsNode.directory) ||
					(ws.nativeWorkspaceId && wsNode.nativeWorkspaceId && ws.nativeWorkspaceId !== wsNode.nativeWorkspaceId)) {
					setLinkSessionError("工作区绑定信息已变化，拒绝关联 / Workspace binding info changed; link refused");
					return;
				}

				const titleInput = typeof document === "undefined" ? null : document.querySelector("[data-wo-link-session-title-input]");
				const rawTitle = titleInput !== null && typeof titleInput.value === "string" ? titleInput.value : linkSessionDraftTitleRef.current;
				const name = rawTitle.trim();

				const idInput = typeof document === "undefined" ? null : document.querySelector("[data-wo-link-session-id-input]");
				const rawId = idInput !== null && typeof idInput.value === "string" ? idInput.value : linkSessionDraftSessionIdRef.current;
				const sId = rawId.trim();

				if (name.length === 0 || name.length > 200) {
					setLinkSessionError("Name must be 1–200 characters");
					return;
				}
				if (sId.length === 0) {
					setLinkSessionError("Session ID must not be empty");
					return;
				}

				const alreadyBound = snapshot.nodes.find((n) => n.kind === "conversation" && n.sessionId === sId);
				if (alreadyBound !== undefined) {
					const msg = `该 Session 已在工作区中关联 / Session already linked: ${sId}`;
					setLinkSessionError(msg);
					setNotice(msg);
					return;
				}

				linkSessionSubmittingRef.current = true;
				setLinkSessionSubmitting(true);
				setLinkSessionError("");
				setBusy(true);

				refreshRequest.current += 1;
				const generation = linkSessionRequest.current + 1;
				linkSessionRequest.current = generation;

				try {
					const nextSnapshot = await remote.bindDirectoryConversation({
						workspaceId: ws.id,
						title: name,
						sessionId: sId
					}).then(unwrap);

					if (!isMountedRef.current || linkSessionRequest.current !== generation) return;

					const matchingNodes = nextSnapshot && Array.isArray(nextSnapshot.nodes)
						? nextSnapshot.nodes.filter(
							(entry) => entry.kind === "conversation" && entry.sessionId === sId && entry.parentId === ws.id
						)
						: [];

					if (matchingNodes.length !== 1) {
						linkSessionUnconfirmedRef.current = true;
						linkSessionSubmittingRef.current = false;
						setLinkSessionSubmitting(false);
						const msg = matchingNodes.length === 0
							? "返回快照中未找到匹配的会话身份，结果未确认 / Matching conversation identity not found in returned snapshot; result unconfirmed"
							: "返回快照中会话身份不唯一或归属异常，结果未确认 / Ambiguous conversation identity in returned snapshot; result unconfirmed";
						setLinkSessionError(msg);
						setLinkSessionUnconfirmed(true);
						setNotice(msg);
						return;
					}

					const confirmedNode = matchingNodes[0];

					linkSessionToken.current += 1;
					linkSessionWorkspaceRef.current = null;
					linkSessionDraftTitleRef.current = "";
					linkSessionDraftSessionIdRef.current = "";
					linkSessionUnconfirmedRef.current = false;

					setSnapshot(nextSnapshot);
					setSnapshotStale(false);
					setLinked((previous) => {
						const copy = new Set(previous);
						copy.add(confirmedNode.id);
						return copy;
					});
					setLinkStatus(`Linked ${sId} (not opened)`);
					setNotice("");

					setLinkSessionActive(false);
					setLinkSessionWorkspace(null);
					setLinkSessionDraftTitle("");
					setLinkSessionDraftSessionId("");
					setLinkSessionError("");
					setLinkSessionUnconfirmed(false);
					linkSessionSubmittingRef.current = false;
					setLinkSessionSubmitting(false);
					setTitle("");
					setSessionId("");

					try {
						const refreshed = await remote.snapshot().then(unwrap);
						if (isMountedRef.current && linkSessionRequest.current === generation) {
							setSnapshot(refreshed);
							setSnapshotStale(false);
						}
					} catch (refreshErr) {
						if (isMountedRef.current && linkSessionRequest.current === generation) {
							setSnapshotStale(true);
							setNotice("会话关联已确认；但后续快照刷新失败，显示最后确认快照 / Conversation link confirmed; background refresh failed, showing last confirmed snapshot");
						}
					}
				} catch (error) {
					if (!isMountedRef.current || linkSessionRequest.current !== generation) return;
					linkSessionUnconfirmedRef.current = true;
					linkSessionSubmittingRef.current = false;
					setLinkSessionSubmitting(false);
					const msg = failureText(error);
					setLinkSessionError(msg);
					setLinkSessionUnconfirmed(true);
					setNotice("传输结果未知或关联失败，结果未确认，勿重复关联 / Result unconfirmed or failed: " + msg);
				} finally {
					if (linkSessionRequest.current === generation) {
						linkSessionSubmittingRef.current = false;
						setLinkSessionSubmitting(false);
						setBusy(false);
					}
				}
			};

			const bindSession = () => {
				startLinkSession();
			};

			const cancelProjectSessionLink = (context) => {
				if (!isMountedRef.current || projectSessionLinkSubmittingRef.current) return;
				const target = projectSessionLinkTargetRef.current;
				if (context && (target === null || target.id !== context.projectId || projectSessionLinkToken.current !== context.token)) return;
				projectSessionLinkToken.current += 1;
				projectSessionLinkRequest.current += 1;
				projectSessionLinkTargetRef.current = null;
				projectSessionLinkTitleRef.current = "";
				projectSessionLinkIdRef.current = "";
				projectSessionLinkUnconfirmedRef.current = false;
				setProjectSessionLinkActive(false);
				setProjectSessionLinkTarget(null);
				setProjectSessionLinkTitle("");
				setProjectSessionLinkId("");
				setProjectSessionLinkError("");
				setProjectSessionLinkUnconfirmed(false);
			};

			const startProjectSessionLink = (explicitNode) => {
				if (!isMountedRef.current || busy || projectSessionLinkSubmittingRef.current) return;
				if (projectSessionLinkActive || projectSessionLinkTargetRef.current !== null) return;
				if (createProjectActive || linkWorkspaceActive || linkSessionActive || movePreviewRef.current !== null || renameTargetRef.current !== null) {
					setNotice("Finish or cancel the other organizer action before linking a Session");
					return;
				}
				const liveSnapshot = snapshot;
				const target = explicitNode ?? selectedNode;
				if (liveSnapshot === null || snapshotStale) {
					setProjectSessionLinkError("Tree is not current; refresh before linking a Session");
					return;
				}
				if (target === undefined || target === null || target.kind !== "project" || target.id === liveSnapshot.rootId || target.parentId === null) {
					setProjectSessionLinkError("Select a Project folder first; Root cannot contain a linked Session");
					return;
				}
				if (!validateAncestorChain(target, liveSnapshot)) {
					setProjectSessionLinkError("Invalid or cyclic folder path; linking refused");
					return;
				}
				const folder = { id: target.id, title: target.title, path: pathOf(target) };
				projectSessionLinkToken.current += 1;
				projectSessionLinkTargetRef.current = folder;
				projectSessionLinkTitleRef.current = "";
				projectSessionLinkIdRef.current = "";
				projectSessionLinkUnconfirmedRef.current = false;
				setProjectSessionLinkTarget(folder);
				setProjectSessionLinkTitle("");
				setProjectSessionLinkId("");
				setProjectSessionLinkError("");
				setProjectSessionLinkUnconfirmed(false);
				setProjectSessionLinkActive(true);
			};

			const confirmProjectSessionLink = async (context) => {
				if (!isMountedRef.current || projectSessionLinkSubmittingRef.current) return;
				const folder = projectSessionLinkTargetRef.current;
				if (!projectSessionLinkActive || folder === null || !context || folder.id !== context.projectId || projectSessionLinkToken.current !== context.token) return;
				if (projectSessionLinkUnconfirmedRef.current || projectSessionLinkUnconfirmed) {
					setProjectSessionLinkError("Result is unconfirmed; cancel and refresh before trying again");
					return;
				}
				if (snapshot === null || snapshotStale) {
					setProjectSessionLinkError("Tree is not current; linking refused");
					return;
				}
				const target = snapshot.nodes.find((node) => node.id === folder.id);
				if (target === undefined || target.kind !== "project" || target.parentId === null || !validateAncestorChain(target, snapshot)) {
					setProjectSessionLinkError("Target folder is no longer valid; linking refused");
					return;
				}
				const folderEl = typeof document === "undefined" ? null : document.querySelector("[data-wo-existing-session-folder]");
				if (folderEl !== null && folderEl.getAttribute("data-wo-existing-session-folder") !== folder.id) {
					setProjectSessionLinkError("Target folder mismatch; linking refused");
					return;
				}
				const titleInput = typeof document === "undefined" ? null : document.querySelector("[data-wo-existing-session-title]");
				const rawTitle = titleInput !== null && typeof titleInput.value === "string" ? titleInput.value : projectSessionLinkTitleRef.current;
				const title = rawTitle.trim();
				const idInput = typeof document === "undefined" ? null : document.querySelector("[data-wo-existing-session-id]");
				const rawId = idInput !== null && typeof idInput.value === "string" ? idInput.value : projectSessionLinkIdRef.current;
				const sessionId = rawId.trim();
				if (title.length === 0 || title.length > 200) {
					setProjectSessionLinkError("Name must be 1–200 characters");
					return;
				}
				if (sessionId.length === 0) {
					setProjectSessionLinkError("Session ID must not be empty");
					return;
				}
				if (snapshot.nodes.some((node) => node.kind === "conversation" && node.sessionId === sessionId)) {
					setProjectSessionLinkError("This Session is already linked in the Organizer");
					return;
				}

				projectSessionLinkSubmittingRef.current = true;
				setProjectSessionLinkSubmitting(true);
				setProjectSessionLinkError("");
				setBusy(true);
				refreshRequest.current += 1;
				const generation = projectSessionLinkRequest.current + 1;
				projectSessionLinkRequest.current = generation;
				try {
					const nextSnapshot = await remote.linkExistingSession({ projectId: folder.id, title, sessionId }).then(unwrap);
					if (!isMountedRef.current || projectSessionLinkRequest.current !== generation) return;
					const matches = nextSnapshot && Array.isArray(nextSnapshot.nodes)
						? nextSnapshot.nodes.filter((node) => node.kind === "conversation" && node.sessionId === sessionId && node.parentId === folder.id)
						: [];
					if (matches.length !== 1) {
						projectSessionLinkUnconfirmedRef.current = true;
						setProjectSessionLinkUnconfirmed(true);
						setProjectSessionLinkError("Returned tree did not confirm one matching Session link; cancel and verify before retrying");
						return;
					}
					const linkedConversation = matches[0];
					projectSessionLinkTargetRef.current = null;
					projectSessionLinkTitleRef.current = "";
					projectSessionLinkIdRef.current = "";
					projectSessionLinkUnconfirmedRef.current = false;
					setSnapshot(nextSnapshot);
					setSnapshotStale(false);
					setLinked((previous) => { const copy = new Set(previous); copy.add(linkedConversation.id); return copy; });
					setLinkStatus(`Linked existing Session ${sessionId}`);
					setNotice("");
					setProjectSessionLinkActive(false);
					setProjectSessionLinkTarget(null);
					setProjectSessionLinkTitle("");
					setProjectSessionLinkId("");
					setProjectSessionLinkError("");
					setProjectSessionLinkUnconfirmed(false);
				} catch (error) {
					if (!isMountedRef.current || projectSessionLinkRequest.current !== generation) return;
					projectSessionLinkUnconfirmedRef.current = true;
					setProjectSessionLinkUnconfirmed(true);
					setProjectSessionLinkError(failureText(error));
					setNotice("Session link failed or could not be confirmed; cancel and refresh before retrying");
				} finally {
					if (projectSessionLinkRequest.current === generation) {
						projectSessionLinkSubmittingRef.current = false;
						setProjectSessionLinkSubmitting(false);
						setBusy(false);
					}
				}
			};

			const open = async (node) => {
				if (node.kind !== "conversation" || node.sessionId === undefined) return;
				try {
					const target = await remote.conversationTarget({ conversationId: node.id }).then(unwrap);
					const workspace = getUiWorkspace();
					if (workspace === undefined) {
						setNotice("uiWorkspace is unavailable; cannot open the Session");
						return;
					}
					if (typeof workspace.openSession !== "function") {
						setNotice("uiWorkspace.openSession is unavailable; cannot open the Session");
						return;
					}
					await workspace.openSession(target.sessionId);
					if (isMountedRef.current) setNotice(`Opened Session ${target.sessionId}`);
				} catch (error) {
					setNotice(failureText(error));
				}
			};

			const button = (label, onClick, disabled) => h("button", {
				type: "button",
				disabled: busy || disabled === true,
				onClick,
				style: rowButtonStyle
			}, label);

			const conversationCap = evaluateConversationCapability(status, snapshotStale);

			return h("div", {
				"data-wo-root": "true",
				style: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px", flex: "1 1 0%", minHeight: "0", minWidth: "0", width: "100%", boxSizing: "border-box", overflowY: "auto" }
			},
			h("style", { "data-wo-lite-theme": "true" }, liteStyles),
			/* 1. Header */
			h("div", { style: { display: "flex", alignItems: "center", gap: "6px", paddingBottom: "4px", borderBottom: "1px solid rgba(128,128,128,0.2)" } },
				h("strong", { style: { fontSize: "14px", flex: "1" }, title: "Workspace Organizer Lite" }, "工作区"),
				h("button", {
					type: "button",
					"data-wo-task-center": "true",
					title: "只读任务台账 (Read-only Task Ledger)",
					onClick: () => { void loadTaskCenter() },
					style: rowButtonStyle
				}, "任务"),
				h("button", {
					type: "button",
					"data-wo-refresh": "true",
					disabled: busy || renameSubmitting || moveSubmitting || createProjectSubmitting || linkWorkspaceSubmitting || linkSessionSubmitting || projectSessionLinkSubmitting,
					onClick: () => { void refresh() },
					style: rowButtonStyle
				}, "↻")),
			status === null ? null : h("div", {
				"data-wo-status": status.conversationsCreatable === true ? "ready" : "blocked",
				title: status.sessionSource,
				style: { fontSize: "10px", opacity: "0.7" }
			}, status.conversationsCreatable === true
				? "Conversations available"
				: `Conversations blocked: ${resolveConversationReason(status)}`),
			snapshotStale ? h("div", { "data-wo-snapshot-stale": "true", style: { fontSize: "10px", color: "#b9770e" } }, "Showing the last known tree; refresh failed") : null,
			notice.length === 0 ? null : h("div", {
				"data-wo-notice": "error",
				style: { fontSize: "10px", color: "#c0392b", whiteSpace: "pre-wrap" }
			}, notice),
			linkStatus.length === 0 ? null : h("div", {
				"data-wo-link-status": "true",
				style: { fontSize: "10px", opacity: "0.75" }
			}, linkStatus),

			/* 1.1 Persistent Navigation Restore Entry */
			h("div", {
				"data-wo-navigation-restore": "true",
				style: { display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap", fontSize: "10px", padding: "2px 0" }
			},
				visibleSections.size < 3 ? h("span", { style: { opacity: "0.6" } }, `Hidden sections (${String(3 - visibleSections.size)}):`) : null,
				!visibleSections.has("quick-access") ? h("button", {
					type: "button",
					"data-wo-restore-section": "quick-access",
					title: "恢复快速访问分区 (Restore Quick Access)",
					"aria-label": "Restore Quick Access",
					onClick: (event) => {
						event.stopPropagation();
						restoreSection("quick-access");
					},
					style: rowButtonStyle
				}, "+ Quick Access") : null,
				!visibleSections.has("projects") ? h("button", {
					type: "button",
					"data-wo-restore-section": "projects",
					title: "恢复项目分区 (Restore Projects)",
					"aria-label": "Restore Projects",
					onClick: (event) => {
						event.stopPropagation();
						restoreSection("projects");
					},
					style: rowButtonStyle
				}, "+ Projects") : null,
				!visibleSections.has("recent") ? h("button", {
					type: "button",
					"data-wo-restore-section": "recent",
					title: "恢复最近分区 (Restore Recent)",
					"aria-label": "Restore Recent",
					onClick: (event) => {
						event.stopPropagation();
						restoreSection("recent");
					},
					style: rowButtonStyle
				}, "+ Recent") : null,
				visibleSections.size < 3 ? h("button", {
					type: "button",
					"data-wo-restore-all": "true",
					title: "恢复全部分区 (Restore All Sections)",
					"aria-label": "Restore All Sections",
					onClick: (event) => {
						event.stopPropagation();
						restoreAllSections();
					},
					style: rowButtonStyle
				}, "Restore All") : null),

			/* 2. Three Navigation Sections */

			/* 2.1 Quick Access */
			!visibleSections.has("quick-access") ? null : h("div", {
				"data-wo-section": "quick-access",
				style: sectionStyle
			},
				h("div", {
					style: sectionHeaderStyle
				},
					h("div", {
						role: "button",
						tabIndex: 0,
						"aria-expanded": String(!quickAccessCollapsed),
						onClick: () => setQuickAccessCollapsed(!quickAccessCollapsed),
						style: { display: "flex", alignItems: "center", flex: "1", cursor: "pointer" }
					},
						h("span", { style: { opacity: "0.55", marginRight: "4px" } }, quickAccessCollapsed ? "▸" : "▾"),
						h("span", { style: { fontWeight: "600", fontSize: "11px" } }, "Quick Access"),
						h("span", { style: { fontSize: "9px", opacity: "0.5", marginLeft: "4px" } },
							snapshot === null ? "(Loading…)" : `(${String(quickAccessItems.length + quickAccessTasks.length)})`)),
					h("button", {
						type: "button",
						"data-wo-section-hide": "quick-access",
						title: "隐藏快速访问分区 (Hide Quick Access)",
						"aria-label": "Hide Quick Access",
						onClick: (event) => {
							event.stopPropagation();
							hideSection("quick-access");
						},
						style: rowButtonStyle
					}, "Hide")),
				!quickAccessCollapsed ? (snapshot === null
					? h("div", {
						"data-wo-quick-access-loading": "true",
						style: sectionBodyStyle
					}, h("div", { style: { fontSize: "10px", opacity: "0.6" } }, "Loading quick access…"))
					: h("div", { style: sectionBodyStyle },
						snapshotStale ? h("div", {
							"data-wo-quick-access-stale": "true",
							style: { fontSize: "10px", color: "#b9770e", padding: "2px 0" }
						}, "快照已陈旧；仅供观察，禁止新增/排序/定位，可执行移除 (Snapshot stale; reorder/locate disabled, removal allowed)") : null,
						h("div", {
							"data-wo-quick-access-notice": "true",
							style: { fontSize: "9px", opacity: "0.55", padding: "2px 0" }
						}, "本次挂载收藏；刷新/重新挂载后重置；快捷打开尚未接线"),
						(quickAccessItems.length === 0 && quickAccessTasks.length === 0)
							? h("div", {
								"data-wo-quick-access-empty": "true",
								style: { display: "flex", flexDirection: "column", gap: "2px", paddingTop: "2px" }
							},
								h("div", { style: { fontSize: "10px", opacity: "0.6" } }, "暂无快捷访问项（可在项目树中点击“☆ Pin”收藏）"),
								h("div", { style: { fontSize: "10px", opacity: "0.6" } }, "尚未实现（无合法快捷访问数据源，不使用模拟项填充）"),
								h("div", { style: { fontSize: "9px", opacity: "0.4" } }, "分区拖动排序 / 自由调高：未实现"))
							: h("div", {
								"data-wo-quick-access-list": "true",
								style: { display: "flex", flexDirection: "column", gap: "1px", marginTop: "2px" }
							},
								quickAccessItems.map((id, index) => {
									const node = snapshot.nodes.find((entry) => entry.id === id);
									if (node === undefined) return null;
									const kindIcon = node.kind === "project" ? "📁" : (node.kind === "workspace" ? "💻" : "💬");
									const isFirst = index === 0;
									const isLast = index === quickAccessItems.length - 1;
									const itemToken = quickAccessTokensRef.current.get(id);
									return h("div", {
										key: id,
										"data-wo-quick-access-row": id,
										"data-wo-kind": node.kind,
										title: `${pathOf(node)} (${node.kind})`,
										onClick: (event) => {
											event.stopPropagation();
										},
										style: Object.assign({}, rowStyle, {
											paddingLeft: "4px",
											paddingRight: "4px",
											cursor: "default"
										})
									},
										h("span", { style: { opacity: "0.7", marginRight: "4px", fontSize: "11px" } }, kindIcon),
										h("span", {
											"data-wo-quick-access-title": id,
											style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 0%", minWidth: "0" }
										}, node.title || "(untitled)"),
										h("span", {
											"data-wo-quick-access-path": id,
											title: pathOf(node),
											style: { fontSize: "9px", opacity: "0.5", marginLeft: "4px", marginRight: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "120px" }
										}, pathOf(node)),
										h("button", {
											type: "button",
											"data-wo-quick-access-locate": id,
											disabled: snapshotStale,
											title: "定位树节点 (Locate in Projects tree)",
											"aria-label": `Locate ${node.title} in Projects tree`,
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												locateNode(id, {
													quickAccessIntent: {
														nodeId: id,
														membershipToken: itemToken,
														nodeKind: node.kind
													}
												});
											}
										}, "Locate"),
										h("button", {
											type: "button",
											"data-wo-quick-access-up": id,
											disabled: isFirst || snapshotStale,
											title: "上移 (Move Up)",
											"aria-label": `Move ${node.title} up`,
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												moveQuickAccessUp(id, itemToken);
											}
										}, "↑"),
										h("button", {
											type: "button",
											"data-wo-quick-access-down": id,
											disabled: isLast || snapshotStale,
											title: "下移 (Move Down)",
											"aria-label": `Move ${node.title} down`,
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												moveQuickAccessDown(id, itemToken);
											}
										}, "↓"),
										h("button", {
											type: "button",
											"data-wo-quick-access-remove": id,
											title: "移除快捷访问 (Remove)",
											"aria-label": `Remove ${node.title} from Quick Access`,
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												removeQuickAccess(id, itemToken);
											}
										}, "✕"));
								}),
								quickAccessTasks.map((item, index) => {
									const sourceNode = snapshot && Array.isArray(snapshot.nodes)
										? snapshot.nodes.find((entry) => entry.id === item.sourceConversationId)
										: null;
									const sourceTitle = sourceNode && sourceNode.title ? sourceNode.title : item.sourceConversationId;
									let taskLabel = item.taskId;
									const centerTask = taskCenterLedger && Array.isArray(taskCenterLedger.tasks)
										? taskCenterLedger.tasks.find((t) => t.taskId === item.taskId && t.sourceConversationId === item.sourceConversationId)
										: null;
									if (centerTask && centerTask.label) {
										taskLabel = centerTask.label;
									} else {
										const treeTask = taskLedger && Array.isArray(taskLedger.tasks)
											? taskLedger.tasks.find((t) => t.taskId === item.taskId && t.sourceConversationId === item.sourceConversationId)
											: null;
										if (treeTask && treeTask.label) {
											taskLabel = treeTask.label;
										}
									}
									const isFirst = index === 0;
									const isLast = index === quickAccessTasks.length - 1;
									const taskKey = `${item.taskId}:${item.sourceConversationId}`;
									let itemToken = taskMembershipTokensRef.current.get(taskKey);
									if (itemToken === undefined) {
										itemToken = ++taskMembershipSeqRef.current;
										taskMembershipTokensRef.current.set(taskKey, itemToken);
									}
									return h("div", {
										key: `task:${item.sourceConversationId}:${item.taskId}`,
										"data-wo-quick-access-task": item.taskId,
										"data-wo-quick-access-task-source": item.sourceConversationId,
										"data-wo-kind": "task",
										title: `${taskLabel} [Task in ${sourceTitle}]`,
										onClick: (event) => {
											event.stopPropagation();
										},
										style: Object.assign({}, rowStyle, {
											paddingLeft: "4px",
											paddingRight: "4px",
											cursor: "default"
										})
									},
										h("span", {
											style: { opacity: "0.7", marginRight: "4px", fontSize: "10px", fontWeight: "600" }
										}, "[Task]"),
										h("span", {
											"data-wo-quick-access-task-title": item.taskId,
											style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 0%", minWidth: "0" }
										}, taskLabel),
										h("span", {
											"data-wo-quick-access-task-source-label": item.taskId,
											title: `${sourceTitle} (${item.sourceConversationId})`,
											style: { fontSize: "9px", opacity: "0.5", marginLeft: "4px", marginRight: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "120px" }
										}, sourceTitle),
										h("button", {
											type: "button",
											"data-wo-quick-access-task-view": item.taskId,
											title: "查看详情 (View Detail)",
											"aria-label": `View detail for ${taskLabel}`,
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												void viewQuickAccessTaskDetail({
													taskId: item.taskId,
													sourceConversationId: item.sourceConversationId,
													membershipToken: itemToken
												});
											}
										}, "View Detail"),
										h("button", {
											type: "button",
											"data-wo-quick-access-task-up": item.taskId,
											"data-wo-quick-access-task-source": item.sourceConversationId,
											disabled: isFirst || snapshotStale,
											title: "上移 (Move Up)",
											"aria-label": `Move ${taskLabel} up`,
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												moveQuickAccessTaskUp(item.taskId, item.sourceConversationId, itemToken);
											}
										}, "↑"),
										h("button", {
											type: "button",
											"data-wo-quick-access-task-down": item.taskId,
											"data-wo-quick-access-task-source": item.sourceConversationId,
											disabled: isLast || snapshotStale,
											title: "下移 (Move Down)",
											"aria-label": `Move ${taskLabel} down`,
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												moveQuickAccessTaskDown(item.taskId, item.sourceConversationId, itemToken);
											}
										}, "↓"),
										h("button", {
											type: "button",
											"data-wo-quick-access-task-remove": item.taskId,
											title: "移除快捷访问 (Remove)",
											"aria-label": `Remove ${taskLabel} from Quick Access`,
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												unpinTask(item.taskId, item.sourceConversationId, itemToken);
											}
										}, "✕"));
								})))) : null),

			/* 2.2 Projects Section */
			!visibleSections.has("projects") ? null : h("div", {
				"data-wo-section": "projects",
				style: sectionStyle
			},
				h("div", {
					style: sectionHeaderStyle
				},
					h("div", {
						role: "button",
						tabIndex: 0,
						"aria-expanded": String(!projectsCollapsed),
						onClick: () => setProjectsCollapsed(!projectsCollapsed),
						style: { display: "flex", alignItems: "center", flex: "1", cursor: "pointer" }
					},
						h("span", { style: { opacity: "0.55", marginRight: "4px" } }, projectsCollapsed ? "▸" : "▾"),
						h("span", { style: { fontWeight: "600", fontSize: "12px" } }, "文件夹"),
						h("span", { "data-wo-tree-count": "true", style: { fontSize: "9px", opacity: "0.5", marginLeft: "4px" } }, snapshot === null ? "" : `(${String(visibleRows.length)})`)),
					h("button", {
						type: "button",
						"data-wo-create-toggle": "true",
						onClick: (event) => {
							event.stopPropagation();
							setCreatePanelOpen(!createPanelOpen);
						},
						style: rowButtonStyle,
						title: "新建项目或终端工作区"
					}, createPanelOpen ? "×" : "＋"),
					h("button", {
						type: "button",
						"data-wo-section-hide": "projects",
						title: "隐藏项目分区 (Hide Projects)",
						"aria-label": "Hide Projects",
						onClick: (event) => {
							event.stopPropagation();
							hideSection("projects");
						},
						style: Object.assign({}, rowButtonStyle, { marginLeft: "4px" })
					}, "Hide")),
				!projectsCollapsed ? h("div", { style: { display: "flex", flexDirection: "column", gap: "1px", marginTop: "2px" } },
					snapshot === null
						? h("div", { style: { fontSize: "10px", opacity: "0.6", padding: "4px 8px" } }, "Loading projects…")
						: (visibleRows.length === 0
							? h("div", { style: { fontSize: "10px", opacity: "0.6", padding: "4px 8px" } }, "No projects in workspace")
							: visibleRows.map((row) => {
								const isProject = row.node.kind === "project";
								const isWorkspace = row.node.kind === "workspace";
								const isConversation = row.node.kind === "conversation";
								const expanded = isProject && !collapsed.has(row.node.id);
								return h("div", {
									key: row.node.id,
									"data-wo-node-id": row.node.id,
									"data-wo-selected": selected === row.node.id ? "true" : undefined,
									"data-wo-kind": row.node.kind,
									"data-wo-toggle": isProject ? "true" : undefined,
									"data-wo-terminal": isWorkspace ? "true" : undefined,
									"data-wo-directory": isWorkspace ? (row.node.directory ?? "") : undefined,
									"data-wo-session-id": isConversation ? (row.node.sessionId ?? "") : undefined,
									"data-wo-linked": linked.has(row.node.id) ? "true" : undefined,
									"aria-expanded": isProject ? String(expanded) : undefined,
									title: isConversation
										? `${pathOf(row.node)} (打开原生会话；尚未提供UX-10产品Tab/多窗口及工具焦点保护)`
										: pathOf(row.node),
									onClick: (event) => {
										event.stopPropagation();
										if (isProject) {
											if (!busy && !snapshotStale) { setSelected(row.node.id); setMoveMode(true); }
											setLiteMenuNode(null);
											toggleProject(row.node.id);
											return;
										}
										if (!renameSubmittingRef.current && !moveSubmittingRef.current && !createProjectSubmittingRef.current && !linkWorkspaceSubmittingRef.current && !linkSessionSubmittingRef.current) {
											setSelected(row.node.id);
											setMoveMode(true);
											setTitle(row.node.title);
											renameToken.current += 1;
											renameTargetRef.current = null;
											setRenameTarget(null);
										}
										open(row.node);
									},
									style: Object.assign({}, rowStyle, {
										paddingLeft: `${String(8 + row.depth * 12)}px`,
										fontWeight: selected === row.node.id ? "600" : "400",
										cursor: "pointer"
									})
								},
									h("span", { "data-wo-disclosure": "true", style: { opacity: "0.55", marginRight: "4px" } }, isProject ? (expanded ? "▾" : "▸") : " "),
									h("span", { "data-wo-kind-icon": "true", "aria-hidden": "true" }, isProject ? "▰" : (isConversation ? "▤" : "⌘")),
									h("span", { "data-wo-node-title": "true", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 0%", minWidth: "0" } }, row.node.title || "(untitled)"),
									isWorkspace ? h("span", { style: { fontSize: "9px", opacity: "0.6", flexBasis: "100%", width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, row.node.directory ?? "") : null,
									isConversation ? h("span", {
										"data-wo-conversation-notice": "true",
										title: "打开原生会话；尚未提供UX-10产品Tab/多窗口及工具焦点保护",
										style: { fontSize: "9px", opacity: "0.55", marginLeft: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
									}, "打开原生会话；尚未提供UX-10产品Tab/多窗口及工具焦点保护") : null,
									h("button", {
										type: "button",
										"data-wo-select": row.node.id,
										style: rowButtonStyle,
										onClick: (event) => {
											event.stopPropagation();
											if (!renameSubmittingRef.current && !moveSubmittingRef.current && !createProjectSubmittingRef.current && !linkWorkspaceSubmittingRef.current && !linkSessionSubmittingRef.current) {
												setSelected(row.node.id);
												setMoveMode(true);
												setTitle(row.node.title);
												setRenameTarget(null);
											}
										}
									}, "Select"),
									(row.node.parentId !== null && row.node.id !== (snapshot === null ? null : snapshot.rootId) && (isProject || isWorkspace || isConversation)) ? (() => {
										const isPinned = quickAccessItems.includes(row.node.id);
										const currentToken = quickAccessTokensRef.current.get(row.node.id);
										return h("button", {
											type: "button",
											"data-wo-quick-access-toggle": row.node.id,
											disabled: snapshotStale,
											title: isPinned ? "取消快捷访问 (Unpin)" : "添加至快捷访问 (Pin)",
											"aria-label": isPinned ? "Unpin from Quick Access" : "Pin to Quick Access",
											style: rowButtonStyle,
											onClick: (event) => {
												event.stopPropagation();
												if (isPinned) {
													toggleQuickAccess(row.node.id, "unpin", currentToken);
												} else {
													toggleQuickAccess(row.node.id, "pin");
												}
											}
										}, isPinned ? "★ Pin" : "☆ Pin");
									})() : null,
									row.node.parentId !== null ? h("button", {
										type: "button",
										"data-wo-rename": row.node.id,
										disabled: snapshotStale || renameSubmitting,
										style: rowButtonStyle,
										onClick: (event) => {
											event.stopPropagation();
											startRename(row.node);
										}
									}, "Rename") : null,
									isProject ? h("button", {
										type: "button",
										"data-wo-find": row.node.id,
										style: rowButtonStyle,
										onClick: (event) => {
											event.stopPropagation();
											openFind(row.node);
										}
									}, "Find") : null,
									isConversation ? h("button", {
										type: "button",
										"data-wo-tasks": row.node.id,
										style: rowButtonStyle,
										onClick: (event) => {
											event.stopPropagation();
											toggleTasks(row.node);
										}
									}, "Tasks") : null,
									isProject ? h("button", {
										type: "button",
										"data-wo-add-child": row.node.id,
										style: rowButtonStyle,
										onClick: (event) => {
											event.stopPropagation();
											setSelected(row.node.id);
											setMoveMode(true);
											setTitle("");
											setCreatePanelOpen(true);
										}
									}, "+") : null,
									h("button", {
									  type: "button",
									  "data-wo-lite-menu-toggle": row.node.id,
									  "aria-label": "更多操作：" + row.node.title,
									  "aria-haspopup": "menu",
									  "aria-expanded": String(liteMenuNode === row.node.id),
									  title: "更多操作",
									  onClick: (event) => {
									    event.stopPropagation();
									    setLiteMenuNode((current) => current === row.node.id ? null : row.node.id);
									  }
									}, "⋯"),
									liteMenuNode === row.node.id ? h("div", {
									  "data-wo-lite-menu": row.node.id,
									  role: "menu",
									  onClick: (event) => event.stopPropagation()
									},
									  row.node.parentId === null ? null : h("button", {
									    type: "button", role: "menuitem",
									    onClick: (event) => {
									      event.stopPropagation();
									      setSelected(row.node.id); setMoveMode(true); setLiteMenuNode(null);
									    }
									  }, "选择并移动…"),
									  row.node.parentId === null ? null : h("button", {
									    type: "button", role: "menuitem", disabled: snapshotStale,
									    onClick: (event) => {
									      event.stopPropagation(); setLiteMenuNode(null); startRename(row.node);
									    }
									  }, "重命名"),
									  isProject ? h("button", {
									    type: "button", role: "menuitem", disabled: snapshotStale,
									    onClick: (event) => {
									      event.stopPropagation(); setLiteMenuNode(null); startCreateProject(row.node);
									    }
									  }, "新建子文件夹") : null,
									  isProject && row.node.parentId !== null ? h("button", {
									    type: "button", role: "menuitem", disabled: snapshotStale,
									    onClick: (event) => {
									      event.stopPropagation(); setLiteMenuNode(null); startProjectSessionLink(row.node);
									    }
									  }, "关联已有会话") : null,
									  isConversation ? h("button", {
									    type: "button", role: "menuitem",
									    onClick: (event) => {
									      event.stopPropagation(); setLiteMenuNode(null); void open(row.node);
									    }
									  }, "打开会话") : null
									) : null);
							}))) : null),

			/* 2.3 Recent Section */
			!visibleSections.has("recent") ? null : h("div", {
				"data-wo-section": "recent",
				style: sectionStyle
			},
				h("div", {
					role: "button",
					tabIndex: 0,
					"aria-expanded": String(!recentCollapsed),
					onClick: () => setRecentCollapsed(!recentCollapsed),
					style: sectionHeaderStyle
				},
					h("span", { style: { opacity: "0.55", marginRight: "4px" } }, recentCollapsed ? "▸" : "▾"),
					h("span", { style: { fontWeight: "600", fontSize: "11px", flex: "1" } }, "Recent"),
					h("span", { style: { fontSize: "9px", opacity: "0.5", marginRight: "4px" } }, "0 items"),
					h("button", {
						type: "button",
						"data-wo-section-hide": "recent",
						title: "隐藏最近分区 (Hide Recent)",
						"aria-label": "Hide Recent",
						onClick: (event) => {
							event.stopPropagation();
							hideSection("recent");
						},
						style: rowButtonStyle
					}, "Hide")),
				!recentCollapsed ? h("div", {
					"data-wo-recent-empty": "true",
					style: sectionBodyStyle
				},
					h("div", { style: { fontSize: "10px", opacity: "0.6" } }, "尚未实现（无用户消息排序或权威事件数据源，不按修改时间或工具日志拼凑）"),
					h("div", { style: { fontSize: "9px", opacity: "0.4" } }, "分区拖动排序 / 自由调高：未实现")) : null),

			/* 3. On-demand Management / Search / Detail Area */

			createPanelOpen ? h("div", {
				"data-wo-create-panel": "true",
				style: { borderTop: "1px solid rgba(128,128,128,0.3)", paddingTop: "4px", display: "flex", flexDirection: "column", gap: "4px", fontSize: "10px" }
			},
				h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
					h("strong", {}, "Create Item:"),
					h("button", {
						type: "button",
						onClick: () => setCreatePanelOpen(false),
						style: rowButtonStyle
					}, "Close")),
				h("div", {
					"data-wo-parent": parentId ?? "none",
					style: { fontSize: "10px", opacity: "0.7" }
				}, parentId === undefined ? "Parent: select a Project or Root" : `Parent: ${selectedNode === undefined ? "Root" : selectedNode.title}`),
				h("input", {
					value: title,
					"data-wo-create-title": "true",
					placeholder: selectedNode === undefined ? "New project name" : "Name",
					onChange: (event) => setTitle(event.target.value),
					style: inputStyle
				}),
				h("input", {
					value: directory,
					"data-wo-directory": "true",
					placeholder: "Existing directory (absolute path)",
					onChange: (event) => setDirectory(event.target.value),
					style: inputStyle
				}),
				h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
					h("button", {
						type: "button",
						"data-wo-create-project-start": "true",
						disabled: busy || createProjectActive || createProjectSubmitting || renameSubmitting || moveSubmitting || linkWorkspaceActive || linkWorkspaceSubmitting || linkSessionActive || linkSessionSubmitting || projectSessionLinkActive || projectSessionLinkSubmitting,
						onClick: () => { startCreateProject(); },
						style: rowButtonStyle
					}, "+ Project"),
					button("Rename", triggerPanelRename, selectedNode === undefined || (selectedNode.kind === "project" && selectedNode.parentId === null) || snapshotStale || renameSubmitting || createProjectSubmitting || createProjectActive || linkWorkspaceSubmitting || linkWorkspaceActive || linkSessionSubmitting || linkSessionActive || projectSessionLinkActive || projectSessionLinkSubmitting),
					h("button", {
						type: "button",
						"data-wo-create-conversation": "true",
						disabled: busy || !canCreate || title.trim().length === 0 || !conversationCap.allowed || snapshotStale || renameSubmitting || createProjectSubmitting || createProjectActive || linkWorkspaceSubmitting || linkWorkspaceActive || linkSessionSubmitting || linkSessionActive || projectSessionLinkActive || projectSessionLinkSubmitting,
						onClick: addConversation,
						style: rowButtonStyle
					}, "+ Conversation"),
					h("button", {
						type: "button",
						"data-wo-link": "true",
						"data-wo-link-workspace-start": "true",
						disabled: busy || createProjectActive || createProjectSubmitting || renameSubmitting || moveSubmitting || linkWorkspaceActive || linkWorkspaceSubmitting || linkSessionActive || linkSessionSubmitting || projectSessionLinkActive || projectSessionLinkSubmitting,
						onClick: () => { startLinkWorkspace(); },
						style: rowButtonStyle
					}, "Link Workspace"),
					h("button", {
						type: "button",
						"data-wo-existing-session-start": "true",
						disabled: busy || selectedNode === undefined || selectedNode.kind !== "project" || selectedNode.parentId === null || snapshotStale || projectSessionLinkActive || projectSessionLinkSubmitting,
						onClick: () => { startProjectSessionLink(); },
						style: rowButtonStyle
					}, "Link Existing Session")),
				h("div", {
					"data-wo-conversation-capability": conversationCap.state,
					"data-wo-conversation-capability-reason": conversationCap.reason || undefined,
					style: { fontSize: "10px", opacity: "0.85", marginTop: "2px" }
				}, conversationCap.notice)) : null,
			(() => {
				if (!createProjectActive || createProjectParent === null) return null;
				const formParentId = createProjectParent.id;
				const formToken = createProjectToken.current;
				const createProjectContext = { parentId: formParentId, token: formToken };
				return h("div", {
					"data-wo-create-project-panel": "true",
					"data-wo-create-project-submitting": createProjectSubmitting ? "true" : undefined,
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "4px",
						padding: "6px",
						background: "var(--vscode-editorWidget-background, #252526)",
						border: "1px solid var(--vscode-editorWidget-border, #454545)",
						borderRadius: "2px",
						fontSize: "10px",
						width: "100%",
						marginTop: "4px"
					}
				},
					h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
						h("strong", {}, "新建项目确认 (Confirm Create Project):"),
						h("button", {
							type: "button",
							"data-wo-create-project-cancel": "true",
							disabled: createProjectSubmitting,
							onClick: () => { cancelCreateProject(createProjectContext); },
							style: rowButtonStyle
						}, "Cancel")),
					h("div", {
						"data-wo-create-project-parent": createProjectParent.id,
						"data-wo-create-project-parent-title": createProjectParent.title,
						"data-wo-create-project-parent-path": createProjectParent.path,
						style: { fontSize: "10px", opacity: "0.85" }
					}, `父项目: ${createProjectParent.title} (${createProjectParent.id}) · 路径: ${createProjectParent.path}`),
					h("input", {
						value: createProjectDraft,
						"data-wo-create-project-input": "true",
						placeholder: "项目名称 / Project title (1–200 characters)",
						disabled: busy || createProjectSubmitting,
						onChange: (event) => { handleCreateProjectInput(event, createProjectContext); },
						style: inputStyle
					}),
					h("div", { style: { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" } },
						h("button", {
							type: "button",
							"data-wo-create-project-confirm": "true",
							disabled: busy || createProjectSubmitting,
							onClick: () => { void confirmCreateProject(createProjectContext); },
							style: Object.assign({}, rowButtonStyle, {
								background: "var(--vscode-button-background, #0e639c)",
								color: "var(--vscode-button-foreground, #fff)"
							})
						}, createProjectSubmitting ? "Creating…" : "Confirm Create"),
						h("button", {
							type: "button",
							"data-wo-create-project-cancel": "true",
							disabled: createProjectSubmitting,
							onClick: () => { cancelCreateProject(createProjectContext); },
							style: rowButtonStyle
						}, "Cancel"),
						createProjectSubmitting ? h("span", { "data-wo-create-project-submitting-label": "true", style: { opacity: "0.7" } }, "提交中…") : null
					),
					createProjectError.length === 0 ? null : h("div", {
						"data-wo-create-project-error": "true",
						style: { color: "#c0392b", fontSize: "10px" }
					}, createProjectError),
					createProjectUnconfirmed ? h("div", {
						"data-wo-create-project-unconfirmed": "true",
						style: { color: "#b9770e", fontSize: "10px" }
					}, "传输结果未知或创建失败，结果未确认，勿重复创建 / Result unconfirmed or failed; please cancel or verify before re-submitting") : null
				);
			})(),
			(() => {
				if (!linkWorkspaceActive || linkWorkspaceParent === null) return null;
				const formParentId = linkWorkspaceParent.id;
				const formToken = linkWorkspaceToken.current;
				const linkWorkspaceContext = { parentId: formParentId, token: formToken };
				return h("div", {
					"data-wo-link-workspace-panel": "true",
					"data-wo-link-workspace-submitting": linkWorkspaceSubmitting ? "true" : undefined,
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "4px",
						padding: "6px",
						background: "var(--vscode-editorWidget-background, #252526)",
						border: "1px solid var(--vscode-editorWidget-border, #454545)",
						borderRadius: "2px",
						fontSize: "10px",
						width: "100%",
						marginTop: "4px"
					}
				},
					h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
						h("strong", {}, "关联已有工作区确认 (Confirm Link Workspace):"),
						h("button", {
							type: "button",
							"data-wo-link-workspace-cancel": "true",
							disabled: linkWorkspaceSubmitting,
							onClick: () => cancelLinkWorkspace(linkWorkspaceContext),
							style: rowButtonStyle
						}, "Cancel")),
					h("div", {
						"data-wo-link-workspace-parent": linkWorkspaceParent.id,
						"data-wo-link-workspace-parent-title": linkWorkspaceParent.title,
						"data-wo-link-workspace-parent-path": linkWorkspaceParent.path,
						style: { fontSize: "10px", opacity: "0.85" }
					}, `父项目: ${linkWorkspaceParent.title} (${linkWorkspaceParent.id}) · 路径: ${linkWorkspaceParent.path}`),
					h("div", {
						"data-wo-link-workspace-disclosure": "true",
						style: { fontSize: "9px", opacity: "0.65", fontStyle: "italic" }
					}, "关联宿主已登记 Workspace 的单目录映射；不创建/移动目录，不授予额外文件读写或执行权限 / Links a pre-registered host workspace directory mapping; does not create/move directories or grant additional permissions"),
					h("input", {
						value: linkWorkspaceDraftTitle,
						"data-wo-link-workspace-title-input": "true",
						placeholder: "工作区名称 / Workspace title (1–200 characters)",
						disabled: busy || linkWorkspaceSubmitting,
						onChange: (event) => handleLinkWorkspaceTitleInput(event, linkWorkspaceContext),
						style: inputStyle
					}),
					h("input", {
						value: linkWorkspaceDraftDirectory,
						"data-wo-link-workspace-dir-input": "true",
						placeholder: "已登记目录绝对路径 / Registered directory path",
						disabled: busy || linkWorkspaceSubmitting,
						onChange: (event) => handleLinkWorkspaceDirectoryInput(event, linkWorkspaceContext),
						style: inputStyle
					}),
					h("div", { style: { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" } },
						h("button", {
							type: "button",
							"data-wo-link-workspace-confirm": "true",
							disabled: busy || linkWorkspaceSubmitting,
							onClick: () => { void confirmLinkWorkspace(linkWorkspaceContext); },
							style: Object.assign({}, rowButtonStyle, {
								background: "var(--vscode-button-background, #0e639c)",
								color: "var(--vscode-button-foreground, #fff)"
							})
						}, linkWorkspaceSubmitting ? "Linking…" : "Confirm Link"),
						h("button", {
							type: "button",
							"data-wo-link-workspace-cancel": "true",
							disabled: linkWorkspaceSubmitting,
							onClick: () => cancelLinkWorkspace(linkWorkspaceContext),
							style: rowButtonStyle
						}, "Cancel"),
						linkWorkspaceSubmitting ? h("span", { "data-wo-link-workspace-submitting-label": "true", style: { opacity: "0.7" } }, "提交中…") : null
					),
					linkWorkspaceError.length === 0 ? null : h("div", {
						"data-wo-link-workspace-error": "true",
						style: { color: "#c0392b", fontSize: "10px" }
					}, linkWorkspaceError),
					linkWorkspaceUnconfirmed ? h("div", {
						"data-wo-link-workspace-unconfirmed": "true",
						style: { color: "#b9770e", fontSize: "10px" }
					}, "传输结果未知或关联失败，结果未确认，勿重复关联 / Result unconfirmed or failed; please cancel or verify before re-submitting") : null
				);
			})(),
			selectedNode !== undefined && selectedNode.kind === "workspace" ? h("div", {
				"data-wo-bind-panel": "true",
				style: { display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" }
			},
				h("input", {
					value: sessionId,
					"data-wo-session": "true",
					placeholder: "Existing Session ID",
					disabled: busy || linkSessionSubmitting,
					onChange: (event) => setSessionId(event.target.value),
					style: inputStyle
				}),
				h("button", {
					type: "button",
					"data-wo-bind": "true",
					"data-wo-link-session-start": "true",
					disabled: busy || linkSessionSubmitting || renameSubmitting || moveSubmitting || createProjectSubmitting || linkWorkspaceSubmitting || snapshotStale,
					onClick: () => { startLinkSession(); },
					style: rowButtonStyle
				}, "Link Session")) : null,
			(() => {
				if (!linkSessionActive || linkSessionWorkspace === null) return null;
				const formWsId = linkSessionWorkspace.id;
				const formToken = linkSessionToken.current;
				const linkSessionContext = { workspaceId: formWsId, token: formToken };
				return h("div", {
					"data-wo-link-session-panel": "true",
					"data-wo-link-session-submitting": linkSessionSubmitting ? "true" : undefined,
					style: {
						display: "flex",
						flexDirection: "column",
						gap: "4px",
						padding: "6px",
						background: "var(--vscode-editorWidget-background, #252526)",
						border: "1px solid var(--vscode-editorWidget-border, #454545)",
						borderRadius: "2px",
						fontSize: "10px",
						width: "100%",
						marginTop: "4px"
					}
				},
					h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
						h("strong", {}, "关联已有会话确认 (Confirm Link Session):"),
						h("button", {
							type: "button",
							"data-wo-link-session-cancel": "true",
							disabled: linkSessionSubmitting,
							onClick: () => { cancelLinkSession(linkSessionContext); },
							style: rowButtonStyle
						}, "Cancel")),
					h("div", {
						"data-wo-link-session-workspace": linkSessionWorkspace.id,
						"data-wo-link-session-workspace-title": linkSessionWorkspace.title,
						"data-wo-link-session-workspace-path": linkSessionWorkspace.path,
						"data-wo-link-session-workspace-dir": linkSessionWorkspace.directory,
						"data-wo-link-session-workspace-native": linkSessionWorkspace.nativeWorkspaceId,
						style: { fontSize: "10px", opacity: "0.85" }
					}, `目标工作区: ${linkSessionWorkspace.title} (${linkSessionWorkspace.id}) · 路径: ${linkSessionWorkspace.path}`),
					h("div", {
						style: { fontSize: "9px", opacity: "0.75" }
					}, `目录: ${linkSessionWorkspace.directory || "(none)"} · 宿主ID: ${linkSessionWorkspace.nativeWorkspaceId || "(none)"}`),
					h("div", {
						"data-wo-link-session-disclosure": "true",
						style: { fontSize: "9px", opacity: "0.65", fontStyle: "italic" }
					}, "关联宿主已有 Session 映射至此工作区；不调用 openSession，不执行历史任务或恢复 Agent 执行 / Links an existing native Session mapping to this workspace; does not open the Session or execute tasks"),
					h("input", {
						value: linkSessionDraftTitle,
						"data-wo-link-session-title-input": "true",
						placeholder: "会话标题 / Conversation title (1–200 characters)",
						disabled: busy || linkSessionSubmitting,
						onChange: (event) => { handleLinkSessionTitleInput(event, linkSessionContext); },
						style: inputStyle
					}),
					h("input", {
						value: linkSessionDraftSessionId,
						"data-wo-link-session-id-input": "true",
						placeholder: "原生 Session ID / Native Session ID (non-empty)",
						disabled: busy || linkSessionSubmitting,
						onChange: (event) => { handleLinkSessionIdInput(event, linkSessionContext); },
						style: inputStyle
					}),
					h("div", { style: { display: "flex", gap: "4px", alignItems: "center", flexWrap: "wrap" } },
						h("button", {
							type: "button",
							"data-wo-link-session-confirm": "true",
							disabled: busy || linkSessionSubmitting,
							onClick: () => { void confirmLinkSession(linkSessionContext); },
							style: Object.assign({}, rowButtonStyle, {
								background: "var(--vscode-button-background, #0e639c)",
								color: "var(--vscode-button-foreground, #fff)"
							})
						}, linkSessionSubmitting ? "Linking…" : "Confirm Link Session"),
						h("button", {
							type: "button",
							"data-wo-link-session-cancel": "true",
							disabled: linkSessionSubmitting,
							onClick: () => { cancelLinkSession(linkSessionContext); },
							style: rowButtonStyle
						}, "Cancel"),
						linkSessionSubmitting ? h("span", { "data-wo-link-session-submitting-label": "true", style: { opacity: "0.7" } }, "提交中…") : null
					),
					linkSessionError.length === 0 ? null : h("div", {
						"data-wo-link-session-error": "true",
						style: { color: "#c0392b", fontSize: "10px" }
					}, linkSessionError),
					linkSessionUnconfirmed ? h("div", {
						"data-wo-link-session-unconfirmed": "true",
						style: { color: "#b9770e", fontSize: "10px" }
					}, "传输结果未知或关联失败，结果未确认，勿重复关联 / Result unconfirmed or failed; please cancel or verify before re-submitting") : null
				);
			})(),
			(() => {
				if (!projectSessionLinkActive || projectSessionLinkTarget === null) return null;
				const context = { projectId: projectSessionLinkTarget.id, token: projectSessionLinkToken.current };
				return h("div", {
					"data-wo-existing-session-panel": "true",
					"data-wo-existing-session-submitting": projectSessionLinkSubmitting ? "true" : undefined,
					style: { display: "flex", flexDirection: "column", gap: "4px", padding: "6px", background: "var(--vscode-editorWidget-background, #252526)", border: "1px solid var(--vscode-editorWidget-border, #454545)", borderRadius: "2px", fontSize: "10px", width: "100%", marginTop: "4px" }
				},
					h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
						h("strong", {}, "关联已有会话到文件夹 (Link Existing Session):"),
						h("button", { type: "button", "data-wo-existing-session-cancel": "true", disabled: projectSessionLinkSubmitting, onClick: () => cancelProjectSessionLink(context), style: rowButtonStyle }, "Cancel")),
					h("div", { "data-wo-existing-session-folder": projectSessionLinkTarget.id, style: { fontSize: "10px", opacity: "0.85" } }, `文件夹: ${projectSessionLinkTarget.title} · ${projectSessionLinkTarget.path}`),
					h("div", { "data-wo-existing-session-disclosure": "true", style: { fontSize: "9px", opacity: "0.7" } }, "宿主未提供会话列表；输入已有 Session ID。宿主会校验该会话可读后才保存逻辑归类；不会创建会话、移动文件或修改 cwd。 / No host session list is available. Enter an existing Session ID; the host verifies it is readable before saving a logical link. No Session is created and no files or cwd are moved."),
					h("input", {
						value: projectSessionLinkTitle,
						"data-wo-existing-session-title": "true",
						placeholder: "会话显示名称 / Session display name (1–200 characters)",
						disabled: busy || projectSessionLinkSubmitting,
						onChange: (event) => { const value = event.target.value; projectSessionLinkTitleRef.current = value; setProjectSessionLinkTitle(value); },
						style: inputStyle
					}),
					h("input", {
						value: projectSessionLinkId,
						"data-wo-existing-session-id": "true",
						placeholder: "已有 DSH Session ID",
						disabled: busy || projectSessionLinkSubmitting,
						onChange: (event) => { const value = event.target.value; projectSessionLinkIdRef.current = value; setProjectSessionLinkId(value); },
						style: inputStyle
					}),
					h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" } },
						h("button", {
							type: "button",
							"data-wo-existing-session-confirm": "true",
							disabled: busy || projectSessionLinkSubmitting,
							onClick: () => { void confirmProjectSessionLink(context); },
							style: Object.assign({}, rowButtonStyle, { background: "var(--vscode-button-background, #0e639c)", color: "var(--vscode-button-foreground, #fff)" })
						}, projectSessionLinkSubmitting ? "Verifying and linking…" : "Verify and link"),
						projectSessionLinkSubmitting ? h("span", { "data-wo-existing-session-submitting-label": "true", style: { opacity: "0.7" } }, "宿主校验中…") : null),
					projectSessionLinkError.length === 0 ? null : h("div", { "data-wo-existing-session-error": "true", style: { color: "#c0392b", fontSize: "10px" } }, projectSessionLinkError),
					projectSessionLinkUnconfirmed ? h("div", { "data-wo-existing-session-unconfirmed": "true", style: { color: "#b9770e", fontSize: "10px" } }, "结果未确认；请取消并刷新核实后再操作。 / Result unconfirmed; cancel and refresh before retrying.") : null
				);
			})(),
			linkStatus.length === 0 ? null : h("div", {
				"data-wo-link-status": "true",
				style: { fontSize: "10px", opacity: "0.75" }
			}, linkStatus),
			canMove && moveMode ? (function () {
				const currentSourceId = selectedNode ? selectedNode.id : null;
				const currentPreview = movePreview;
				const currentPreviewToken = movePreviewToken.current;
				const previewContext = currentPreview !== null ? {
					sourceId: currentPreview.sourceId,
					targetId: currentPreview.targetId,
					token: currentPreview.token !== undefined ? currentPreview.token : currentPreviewToken
				} : null;
				const emptyCancelContext = {
					sourceId: null,
					targetId: null,
					token: currentPreviewToken
				};
				return h("div", {
					"data-wo-move-panel": "true",
					"data-wo-move-submitting": moveSubmitting ? "true" : undefined,
					style: { display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center", fontSize: "10px" }
				},
					h("span", { "data-wo-move-source": currentPreview !== null ? currentPreview.sourceId : selectedNode.id }, `Move ${selectedNode.title}:`),
					h("button", {
						type: "button",
						"data-wo-move-to": "root",
						disabled: busy || moveSubmitting,
						onClick: () => moveTo("root", currentSourceId),
						style: rowButtonStyle
					}, "Root"),
					moveTargets.map((target) => h("button", {
						key: target.id,
						type: "button",
						"data-wo-move-to": target.id,
						disabled: busy || moveSubmitting,
						onClick: () => moveTo(target.id, currentSourceId),
						style: rowButtonStyle
					}, target.title)),
					currentPreview !== null ? h("div", {
						"data-wo-move-preview": "true",
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "3px",
							padding: "6px",
							background: "var(--vscode-editorWidget-background, #252526)",
							border: "1px solid var(--vscode-editorWidget-border, #454545)",
							borderRadius: "2px",
							width: "100%",
							marginTop: "4px"
						}
					},
						h("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
							h("span", { "data-wo-move-source": currentPreview.sourceId, style: { fontWeight: "600" } }, `源: ${currentPreview.sourceTitle} (${currentPreview.sourceId})`),
							h("span", { style: { opacity: "0.6" } }, "→"),
							h("span", { "data-wo-move-target": currentPreview.targetId, style: { fontWeight: "600" } }, `目标: ${currentPreview.targetTitle} (${currentPreview.targetId})`)
						),
						h("div", { style: { fontSize: "9px", opacity: "0.75" } },
							`路径: ${(snapshot === null ? null : (function () {
								const oldP = snapshot.nodes.find((n) => n.id === currentPreview.sourceParentId);
								return oldP ? pathOf(oldP) : "Root";
							})())} → ${(snapshot === null ? null : (function () {
								const newP = snapshot.nodes.find((n) => n.id === currentPreview.targetId);
								return newP ? pathOf(newP) : "Root";
							})())}`
						),
						h("div", {
							"data-wo-move-disclosure": "true",
							style: { fontSize: "9px", opacity: "0.6", fontStyle: "italic" }
						}, currentPreview.sourceKind === "conversation"
							? "仅逻辑归属；保留原 Session；不搬文件/迁移 cwd/启动或暂停 Task；不授予历史访问权限 / Logical reorganization only; preserves original Session; does not move files or cwd; does not start or pause Tasks; does not grant historical access permissions"
							: "仅变更逻辑归属，不搬迁文件或进程cwd / Logical reorganization only; does not move physical files or process cwd"),
						h("div", { style: { display: "flex", gap: "4px", marginTop: "4px" } },
							h("button", {
								type: "button",
								"data-wo-move-confirm": "true",
								disabled: busy || moveSubmitting,
								onClick: () => { void confirmMove(previewContext); },
								style: {
									...rowButtonStyle,
									background: "var(--vscode-button-background, #0e639c)",
									color: "var(--vscode-button-foreground, #fff)"
								}
							}, moveSubmitting ? "Moving…" : "Confirm Move"),
							h("button", {
								type: "button",
								"data-wo-move-cancel": "true",
								disabled: moveSubmitting,
								onClick: () => cancelMove(previewContext),
								style: rowButtonStyle
							}, "Cancel")
						)
					) : null,
					currentPreview !== null ? null : h("button", {
						type: "button",
						"data-wo-move-cancel": "true",
						disabled: moveSubmitting,
						onClick: () => cancelMove(emptyCancelContext),
						style: rowButtonStyle
					}, "Cancel"),
					moveError.length === 0 ? null : h("div", {
						"data-wo-move-error": "true",
						style: { color: "var(--vscode-errorForeground, #f48771)", fontSize: "11px", flexBasis: "100%" }
					}, moveError)
				);
			})() : null,
			renameTarget !== null ? (function () {
				const panelTargetId = renameTarget;
				const panelToken = renameToken.current;
				const target = snapshot === null ? undefined : snapshot.nodes.find((node) => node.id === panelTargetId);
				return h("div", {
					"data-wo-rename-panel": "true",
					style: { display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center", fontSize: "10px" }
				},
					h("span", { "data-wo-rename-source": panelTargetId }, target === undefined ? "Rename" : `Rename ${target.kind}: ${target.title}`),
					h("input", {
						value: renameDraft,
						"data-wo-rename-input": "true",
						placeholder: "New name",
						disabled: busy || renameSubmitting,
						onChange: (event) => handleRenameInput(event, { targetId: panelTargetId, token: panelToken }),
						style: inputStyle
					}),
					h("button", {
						type: "button",
						"data-wo-rename-save": "true",
						disabled: busy || renameSubmitting,
						onClick: () => { void saveRename({ targetId: panelTargetId, token: panelToken }); },
						style: rowButtonStyle
					}, renameSubmitting ? "Saving…" : "Save"),
					h("button", {
						type: "button",
						"data-wo-rename-cancel": "true",
						disabled: busy || renameSubmitting,
						onClick: () => cancelRename({ targetId: panelTargetId, token: panelToken }),
						style: rowButtonStyle
					}, "Cancel"),
					renameSubmitting ? h("span", { "data-wo-rename-submitting": "true", style: { opacity: "0.7" } }, "提交中…") : null,
					renameError.length === 0 ? null : h("span", { "data-wo-rename-error": "true", style: { color: "#c0392b" } }, renameError));
			})() : null,
			taskSource !== null ? (function () {
				const panelSourceId = taskSource;
				const panelToken = taskToken.current;
				return h("div", {
					"data-wo-task-panel": panelSourceId,
					style: { borderTop: "1px solid rgba(128,128,128,0.3)", paddingTop: "4px", fontSize: "10px" }
				},
					h("div", { style: { display: "flex", gap: "4px", alignItems: "center" } },
						h("span", { "data-wo-task-source": panelSourceId }, `Tasks for ${panelSourceId}`),
						h("span", { "data-wo-task-revision": taskLedger === null ? "" : String(taskLedger.revision) }, taskLedger === null ? "" : `rev ${String(taskLedger.revision)}`),
						h("button", {
							type: "button",
							"data-wo-task-refresh": "true",
							disabled: busy || taskStatus === "loading" || !hasLiveTaskSource(panelSourceId),
							onClick: () => { void refreshTasks({ sourceId: panelSourceId, token: panelToken }) },
							style: rowButtonStyle
						}, "Refresh tasks")),
					taskError.length === 0 ? null : h("div", { "data-wo-task-error": "true", style: { color: "#c0392b" } }, taskError),
					taskStatus === "stale" ? h("div", { "data-wo-task-stale": "true" }, "Showing stale observation") : null,
					taskStatus === "loading" && taskLedger === null ? h("div", { "data-wo-task-loading": "true" }, "Loading…") : null,
					taskLedger !== null && taskRows(taskLedger, panelSourceId).length === 0 ? (taskLedger.sources.some((entry) => entry.conversationId === panelSourceId)
						? h("div", { "data-wo-task-empty": "true" }, "No tasks observed for this Conversation")
						: h("div", { "data-wo-task-unreconciled": "true" }, "Not reconciled yet")) : null,
					taskLedger !== null ? taskRows(taskLedger, panelSourceId).map((task) => h("div", {
						key: task.taskId,
						"data-wo-task-row": task.taskId,
						"data-wo-task-child": task.childSessionId,
						"data-wo-task-parent": task.parent.kind === "task" ? task.parent.taskId : "",
						"data-wo-task-depth": String(task.depth),
						"data-wo-task-state": task.executionState,
						style: { paddingLeft: `${String(task.depth * 8)}px`, opacity: task.executionEligibility === "blocked" ? "0.6" : "1", display: "flex", alignItems: "center", gap: "6px" }
					},
						h("span", null, `${task.label === undefined ? "(unlabeled)" : task.label} · ${task.taskId} · ${task.executionState}${task.executionEligibility === "blocked" ? ` · blocked: ${task.blockedReason ?? "unknown"}` : ""}`),
						h("button", {
							type: "button",
							"data-wo-task-view": task.taskId,
							disabled: !hasLiveTaskSource(panelSourceId),
							onClick: (event) => {
								event.stopPropagation();
								void viewTaskDetail(task, { sourceId: panelSourceId, token: panelToken });
							},
							style: rowButtonStyle
						}, "查看详情")
					)) : null);
			})() : null,
			findScope !== null ? (function () {
				const activeSnapshot = snapshotRef.current !== null ? snapshotRef.current : snapshot;
				const scope = activeSnapshot === null ? undefined : activeSnapshot.nodes.find((node) => node.id === findScope);
				const activeFindToken = findToken.current;
				const activeQueryVersion = findQueryVersion.current;
				const currentFindContext = {
					scopeId: findScope,
					token: activeFindToken
				};
				return h("div", {
					"data-wo-find-panel": findScope,
					style: { borderTop: "1px solid rgba(128,128,128,0.3)", paddingTop: "4px", fontSize: "10px" }
				},
					h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap", alignItems: "center" } },
						h("span", { "data-wo-find-scope": findScope }, `Find in ${scope === undefined ? "(missing)" : scope.title}:`),
						h("input", {
							value: findQuery,
							"data-wo-find-query": "true",
							placeholder: "Name contains…",
							onChange: (event) => handleFindQueryChange(currentFindContext, event.target.value),
							style: inputStyle
						}),
						h("button", {
							type: "button",
							"data-wo-find-mode": findDescendants ? "descendants" : "direct",
							onClick: () => handleFindModeToggle(currentFindContext),
							style: rowButtonStyle
						}, findDescendants ? "Include descendants" : "Direct only"),
						h("button", { type: "button", "data-wo-find-clear": "true", onClick: () => handleFindClear(currentFindContext), style: rowButtonStyle }, "Clear"),
						h("button", { type: "button", "data-wo-find-close": "true", onClick: () => closeFind(currentFindContext), style: rowButtonStyle }, "Close")),
					h("div", {
						"data-wo-find-notice": "true",
						style: { fontSize: "9px", opacity: "0.6" }
					}, "当前仅按节点名称查找；会话消息全文搜索尚未实现（UX-13）"),
					findQueryText.length === 0 ? h("div", { "data-wo-find-hint": "true" }, "Enter a name to search") : null,
					findQueryText.length > 0 && findResults.length === 0 ? h("div", { "data-wo-find-empty": "true" }, "No matching nodes in this scope") : null,
					findResults.map((result) => {
						const currentResultIntent = {
							scopeId: findScope,
							token: activeFindToken,
							queryVersion: activeQueryVersion,
							queryText: findQueryText,
							descendants: findDescendants,
							targetId: result.id
						};
						return h("div", { key: result.id, style: { display: "flex", gap: "4px", alignItems: "center" } },
							h("span", { style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, `${result.title} · ${result.kind} · ${pathOf(result)}`),
							h("button", {
								type: "button",
								"data-wo-find-result": result.id,
								onClick: () => handleFindLocate(currentResultIntent),
								style: rowButtonStyle,
								title: "定位树节点 (Locate tree node)"
							}, "定位树节点 / Locate"));
					}),
					findLocated.length === 0 ? null : h("div", { "data-wo-find-located": "true" }, findLocated));
			})() : null,
			taskCenterOpen ? (function () {
				const groups = new Map();
				for (const task of filteredTaskCenterTasks) {
					const list = groups.get(task.sourceConversationId) ?? [];
					list.push(task);
					groups.set(task.sourceConversationId, list);
				}
				const sourceTitle = (id) => {
					const source = snapshot === null ? undefined : snapshot.nodes.find((node) => node.id === id);
					return source === undefined ? id : source.title;
				};
				const availableSourceIds = (function () {
					const ids = [];
					const seen = new Set();
					for (const task of taskCenterTasks) {
						if (!seen.has(task.sourceConversationId)) {
							seen.add(task.sourceConversationId);
							ids.push(task.sourceConversationId);
						}
					}
					return ids;
				})();
				const filterOptionIds = availableSourceIds.slice();
				if (taskCenterSourceFilter !== "" && !filterOptionIds.includes(taskCenterSourceFilter)) {
					filterOptionIds.push(taskCenterSourceFilter);
				}
				const selected = taskCenterSelectedTask;
				const selectedSource = selected === null || taskCenterLedger === null || !Array.isArray(taskCenterLedger.sources)
					? null
					: taskCenterLedger.sources.find((source) => source.conversationId === selected.sourceConversationId) ?? null;
				const sourceField = (value) => value === undefined || value === null || value === "" ? "unknown" : String(value);
				const sourceState = selectedSource === null ? "unverified" : sourceField(selectedSource.verificationState);
				const staleDetail = taskCenterStatus === "error" && taskCenterLedger !== null;
				const isSourceFiltered = taskCenterSourceFilter !== "";
				const sourceHasNoTasks = taskCenterLedger !== null && taskCenterTasks.length > 0 && isSourceFiltered && filteredTaskCenterTasks.length === 0;

				const panelLifecycleToken = taskCenterToken.current;
				const relationViewLifetime = taskCenterRelationViewLifetime.current;
				return h("div", {
					"data-wo-task-center-panel": "true",
					style: { borderTop: "1px solid rgba(128,128,128,0.3)", paddingTop: "4px", fontSize: "10px" }
				},
					h("div", { style: { display: "flex", gap: "4px", alignItems: "center" } },
						h("span", { "data-wo-task-center-status": taskCenterStatus }, `Tasks ledger: ${taskCenterStatus}${taskCenterLedger === null ? "" : ` (rev ${taskCenterLedger.revision})`}`),
						h("button", { type: "button", "data-wo-task-center-refresh": "true", onClick: () => { void loadTaskCenter({ preserveFilter: true, isReload: true, token: panelLifecycleToken }) }, style: rowButtonStyle }, "Reload"),
						h("button", { type: "button", "data-wo-task-center-close": "true", onClick: () => closeTaskCenter(relationViewLifetime), style: rowButtonStyle }, "Close")),
					taskCenterStatus === "error" ? h("div", { "data-wo-task-center-error": "true" }, taskCenterError) : null,
					staleDetail ? h("div", { "data-wo-task-center-stale": "true" }, "Showing last observed ledger; request failed (stale)") : null,
					h("div", {
						"data-wo-task-center-filter": "true",
						style: { display: "flex", gap: "6px", alignItems: "center", marginTop: "4px", marginBottom: "4px", flexWrap: "wrap" }
					},
						h("span", {
							"data-wo-task-center-scope": isSourceFiltered ? taskCenterSourceFilter : "all",
							style: { opacity: "0.85" }
						}, `筛选已加载账本 (Filter loaded ledger): ${isSourceFiltered ? `${sourceTitle(taskCenterSourceFilter)} · ${taskCenterSourceFilter}` : "全部来源 / All sources"}`),
						h("select", {
							"data-wo-task-center-filter-select": "true",
							value: taskCenterSourceFilter,
							disabled: taskCenterStatus === "loading",
							onChange: (valOrEvt) => handleTaskCenterFilterChange(valOrEvt, relationViewLifetime),
							style: inputStyle
						},
							h("option", { value: "", "data-wo-filter-option": "all" }, "全部来源 / All sources"),
							filterOptionIds.map((srcId) => h("option", {
								key: srcId,
								value: srcId,
								"data-wo-filter-option": srcId
							}, `${sourceTitle(srcId)} · ${srcId}`))),
						isSourceFiltered ? h("button", {
							type: "button",
							"data-wo-task-center-filter-all": "true",
							disabled: taskCenterStatus === "loading",
							onClick: () => handleTaskCenterFilterChange("", relationViewLifetime),
							style: rowButtonStyle
						}, "All sources") : null),
					taskCenterStatus === "ready" && taskCenterTasks.length === 0 ? h("div", { "data-wo-task-center-empty": "true" }, "No tasks in the current ledger") : null,
					sourceHasNoTasks ? h("div", { "data-wo-task-center-source-empty": "true" }, "当前来源无任务/已不在本账本 (Current source has no tasks or is no longer in this ledger)") : null,
					[...groups.entries()].map(([sourceId, tasks]) => h("div", { key: sourceId, "data-wo-task-center-group": sourceId },
						h("div", { style: { fontWeight: "600" } }, `${sourceTitle(sourceId)} · ${sourceId}`),
						tasks.slice().sort((a, b) => a.depth - b.depth || a.taskId.localeCompare(b.taskId)).map((task) => h("div", { key: task.taskId, style: { display: "flex", gap: "4px", alignItems: "center" } },
							h("button", {
								type: "button",
								"data-wo-task-center-row": task.taskId,
								onClick: () => selectTaskCenterTask(task, relationViewLifetime),
								style: rowButtonStyle
							}, `${task.label ?? task.taskId} · d${task.depth} · ${task.executionState}`))))),
					selected === null ? null : h("div", {
						"data-wo-task-center-detail": selected.taskId,
						style: { marginTop: "4px", paddingTop: "4px", borderTop: "1px dashed rgba(128,128,128,0.3)" }
					},
						h("div", {}, `taskId: ${selected.taskId}`),
						h("div", {}, `sourceConversationId: ${selected.sourceConversationId}`),
						h("div", {}, `parent: ${selected.parent.kind}:${selected.parent.kind === "conversation" ? selected.parent.conversationId : selected.parent.taskId}`),
						h("div", {}, `childSessionId: ${selected.childSessionId}`),
						h("div", {}, `depth/mode: ${selected.depth}/${selected.mode}`),
						h("div", {}, `observedAt: ${selected.observedAt}`),
						h("div", {}, `execution: ${selected.executionState} (${selected.executionEligibility})`),
						selected.blockedReason === undefined ? null : h("div", { "data-wo-task-center-blocked": "true" }, `blocked: ${selected.blockedReason}`),
						h("div", { "data-wo-task-center-resource": "true" },
							h("div", { "data-wo-source-id": selected.sourceConversationId }, `source C: ${selected.sourceConversationId}`),
							h("div", { "data-wo-source-logical": sourceField(selectedSource?.workspaceLogicalId) }, `logical workspace: ${sourceField(selectedSource?.workspaceLogicalId)}`),
							h("div", { "data-wo-source-native": sourceField(selectedSource?.nativeWorkspaceId) }, `native workspace: ${sourceField(selectedSource?.nativeWorkspaceId)}`),
							h("div", { "data-wo-source-directory": sourceField(selectedSource?.directory) }, `observed directory: ${sourceField(selectedSource?.directory)}`),
							h("div", { "data-wo-source-verified-at": sourceField(selectedSource?.verifiedAt) }, `verifiedAt: ${sourceField(selectedSource?.verifiedAt)}`),
							h("div", { "data-wo-source-verification": sourceState }, `verification: ${sourceState}`),
							selectedSource?.blockedReason === undefined ? null : h("div", { "data-wo-source-blocked": "true" }, `source blocked: ${selectedSource.blockedReason}`),
							h("div", { "data-wo-source-stale": staleDetail ? "true" : "false" }, staleDetail ? "last observed source facts; stale" : "last observed source facts only"),
							h("div", {}, `resource session: ${sourceField(selectedSource?.sessionId)}`),
							h("div", {}, `hostVersion: ${sourceField(selectedSource?.hostVersion)}`)),
						h("div", { style: { display: "flex", gap: "4px", alignItems: "center", marginTop: "4px", flexWrap: "wrap" } },
							h("button", { type: "button", "data-wo-task-center-locate": selected.taskId, onClick: () => locateTaskSource(selected), style: rowButtonStyle }, "Locate source"),
							selected.parent && selected.parent.kind === "task"
								? h("button", {
									type: "button",
									"data-wo-task-parent-view": selected.parent.taskId,
									disabled: taskCenterStatus !== "ready",
									title: `查看直属父任务 (View parent task ${selected.parent.taskId})`,
									"aria-label": `View parent task ${selected.parent.taskId}`,
					onClick: () => { void viewParentTaskDetail(selected, { relationViewLifetime }); },
									style: rowButtonStyle
								}, `View parent task (${selected.parent.taskId})`)
								: null,
							(() => {
								const taskKey = `${selected.taskId}:${selected.sourceConversationId}`;
								const isPinned = quickAccessTasks.some((t) => t.taskId === selected.taskId && t.sourceConversationId === selected.sourceConversationId);
								if (isPinned) {
									const currentToken = taskMembershipTokensRef.current.get(taskKey);
									return h("button", {
										type: "button",
										"data-wo-task-unpin": selected.taskId,
										title: "Unpin from Quick Access",
										onClick: () => {
											if (!isCurrentTaskCenterDetailAction(selected, relationViewLifetime)) return;
											unpinTask(selected.taskId, selected.sourceConversationId, currentToken);
										},
										style: rowButtonStyle
									}, "Unpin from Quick Access");
								} else {
									const currentIntent = taskPinIntentRef.current.get(taskKey) || 0;
									return h("button", {
										type: "button",
										"data-wo-task-pin": selected.taskId,
										disabled: snapshotStale || taskCenterStatus !== "ready",
										title: "Pin to Quick Access",
										onClick: () => {
											if (!isCurrentTaskCenterDetailAction(selected, relationViewLifetime)) return;
											pinTask(selected, currentIntent);
										},
										style: rowButtonStyle
									}, "Pin to Quick Access");
								}
							})()),
						taskCenterLocateNotice.length === 0 ? null : h("div", {
							"data-wo-task-center-locate-feedback": "true",
							"data-wo-task-center-locate-state": taskCenterLocateState,
							style: { fontSize: "10px", marginTop: "4px", opacity: "0.85" }
						}, taskCenterLocateNotice),
						(() => {
							const parentCount = (taskCenterLedger && Array.isArray(taskCenterLedger.tasks))
								? taskCenterLedger.tasks.filter((t) => t.taskId === selected.taskId).length
								: 0;
							const directChildren = (taskCenterLedger && Array.isArray(taskCenterLedger.tasks))
								? (function () {
									const matching = taskCenterLedger.tasks.filter((t) => t.parent?.kind === "task" && t.parent.taskId === selected.taskId && t.sourceConversationId === selected.sourceConversationId);
									const seen = new Set();
									const unique = [];
									for (const t of matching) {
										if (seen.has(t.taskId)) continue;
										seen.add(t.taskId);
										unique.push(t);
									}
									return unique.sort((a, b) => a.taskId.localeCompare(b.taskId));
								})()
								: [];
							const hasChildren = directChildren.length > 0;
							return h("div", {
								"data-wo-task-children-section": selected.taskId,
								style: { marginTop: "6px", paddingTop: "4px", borderTop: "1px dotted rgba(128,128,128,0.2)" }
							},
								h("div", { style: { fontWeight: "bold", fontSize: "11px", marginBottom: "2px" } }, "当前账本观察到的直属子任务:"),
								parentCount > 1
									? h("div", {
										"data-wo-task-children-notice": "ambiguous-parent",
										style: { fontSize: "11px", color: "orange" }
									}, "父任务在账本中存在重复，关系未确认")
									: !hasChildren
										? h("div", {
											"data-wo-task-children-empty": "true",
											style: { fontSize: "11px", opacity: "0.7", fontStyle: "italic" }
										}, "本账本未观察到直属子任务 (No direct child tasks observed in ledger)")
										: h("div", {
											"data-wo-task-children-list": selected.taskId,
											style: { display: "flex", flexDirection: "column", gap: "2px" }
										}, directChildren.map((child) => {
											const childDuplicate = (taskCenterLedger?.tasks ?? []).filter((t) => t.taskId === child.taskId).length > 1;
											const childSelfRef = child.taskId === selected.taskId;
											const childMalformed = childDuplicate || childSelfRef;
											return h("div", {
												key: child.taskId,
												"data-wo-task-child-row": child.taskId,
												style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "6px", fontSize: "11px", padding: "2px 0" }
											},
												h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
													`${child.label ?? child.taskId} · ${child.taskId} · d${child.depth} · ${child.executionState}`
												),
												childMalformed
													? h("span", {
														"data-wo-task-child-notice": child.taskId,
														style: { color: "orange", fontSize: "10px" }
													}, "关系未确认")
													: null,
												h("button", {
													type: "button",
													"data-wo-task-child-view": child.taskId,
													disabled: taskCenterStatus !== "ready" || childMalformed,
													title: childMalformed ? `关系未确认 (${child.taskId})` : `查看子任务 (${child.taskId})`,
													"aria-label": `View child task ${child.taskId}`,
								onClick: () => { void viewChildTaskDetail(selected, child, { relationViewLifetime }); },
													style: rowButtonStyle
												}, `View child task (${child.taskId})`));
										}))
							);
						})()));
			})() : null);
		}

		/* First Lite UI pass: present navigation, not the debugging dashboard. */
		const liteStyles = `[data-wo-root]{--wo-line:rgba(148,163,184,.14);--wo-hover:rgba(148,163,184,.14);--wo-accent:var(--vscode-focusBorder,#7b9dff);color:var(--vscode-foreground,inherit);font-family:inherit;gap:10px!important;padding:12px 10px!important;overflow-x:hidden!important}
[data-wo-root]>div:first-of-type{gap:8px!important;min-height:34px;padding:0 3px 9px!important;border-bottom:1px solid var(--wo-line)!important}
[data-wo-root]>div:first-of-type strong{font-size:14px!important;font-weight:650!important;letter-spacing:.2px}
[data-wo-root] button{font:inherit;transition:background-color .14s,opacity .14s;min-height:26px}
[data-wo-root] button:focus-visible,[data-wo-root] [role=button]:focus-visible{outline:2px solid var(--wo-accent);outline-offset:2px}
[data-wo-root] [data-wo-task-center],[data-wo-root] [data-wo-status],[data-wo-root] [data-wo-navigation-restore],[data-wo-root] [data-wo-section="quick-access"],[data-wo-root] [data-wo-section="recent"]{display:none!important}
[data-wo-root] [data-wo-section="projects"]{background:transparent!important;border:0!important;padding:0!important;gap:7px!important}
[data-wo-root] [data-wo-section="projects"]>div:first-child{padding:3px 3px 8px!important;gap:8px!important}
[data-wo-root] [data-wo-section="projects"]>div:first-child [role=button]{min-width:0}
[data-wo-root] [data-wo-section="projects"]>div:first-child [role=button] span:nth-child(2){font-size:12px!important;letter-spacing:.2px;opacity:.82}
[data-wo-root] [data-wo-tree-count],[data-wo-root] [data-wo-section="projects"] [data-wo-section-hide]{display:none!important}
[data-wo-root] [data-wo-create-toggle]{font-size:18px!important;width:29px;height:29px;padding:0!important;border:1px solid transparent!important;border-radius:8px!important;background:transparent!important;color:inherit!important;line-height:1!important}
[data-wo-root] [data-wo-create-toggle]:hover{background:var(--wo-hover)!important}
[data-wo-root] [data-wo-node-id]{position:relative;display:flex!important;flex-wrap:nowrap!important;align-items:center!important;gap:6px!important;min-width:0;height:35px;min-height:35px;padding-top:0!important;padding-bottom:0!important;padding-right:4px!important;border-radius:8px!important;transition:background-color .12s}
[data-wo-root] [data-wo-node-id]:hover{background:var(--wo-hover)!important}
[data-wo-root] [data-wo-node-id][data-wo-selected=true]{background:rgba(113,146,220,.17)!important;box-shadow:inset 2px 0 0 var(--wo-accent)}
[data-wo-root] [data-wo-node-id] [data-wo-disclosure]{width:10px;flex:0 0 10px;text-align:center;font-size:11px;opacity:.58;margin:0!important}
[data-wo-root] [data-wo-node-id] [data-wo-kind-icon]{width:16px;flex:0 0 16px;text-align:center;font-size:15px;opacity:.74}
[data-wo-root] [data-wo-node-id] [data-wo-node-title]{font-size:12px!important;line-height:18px!important;font-weight:inherit;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
[data-wo-root] [data-wo-node-id]>button:not([data-wo-lite-menu-toggle]){display:none!important}
[data-wo-root] [data-wo-node-id]>span[style*="flexBasis"],[data-wo-root] [data-wo-node-id] [data-wo-conversation-notice]{display:none!important}
[data-wo-root] [data-wo-lite-menu-toggle]{border:0!important;border-radius:6px!important;background:transparent!important;color:inherit!important;width:26px;height:27px;min-height:27px;padding:0!important;font-size:20px!important;line-height:20px;opacity:0;flex:0 0 26px}
[data-wo-root] [data-wo-node-id]:hover>[data-wo-lite-menu-toggle],[data-wo-root] [data-wo-node-id]:focus-within>[data-wo-lite-menu-toggle],[data-wo-root] [data-wo-node-id][data-wo-selected=true]>[data-wo-lite-menu-toggle]{opacity:.85}
[data-wo-root] [data-wo-lite-menu-toggle]:hover{background:var(--wo-hover)!important;opacity:1!important}
[data-wo-root] [data-wo-lite-menu]{position:absolute;z-index:30;top:33px;right:2px;display:flex;flex-direction:column;min-width:156px;max-width:235px;padding:5px;background:var(--vscode-menu-background,var(--vscode-editorWidget-background,#24262a));color:var(--vscode-menu-foreground,var(--vscode-foreground,#eaeaea));border:1px solid var(--vscode-menu-border,rgba(148,163,184,.3));box-shadow:0 10px 32px rgba(0,0,0,.35);border-radius:10px}
[data-wo-root] [data-wo-lite-menu] button{background:transparent!important;border:0!important;color:inherit!important;text-align:left!important;white-space:nowrap!important;padding:7px 11px!important;border-radius:6px!important;font-size:12px!important;height:auto!important;min-height:29px}
[data-wo-root] [data-wo-lite-menu] button:hover{background:var(--vscode-list-hoverBackground,rgba(148,163,184,.15))!important}
[data-wo-root] [data-wo-lite-menu] button:disabled{opacity:.4}
[data-wo-root] [data-wo-create-panel],[data-wo-root] [data-wo-create-project-panel],[data-wo-root] [data-wo-project-session-panel],[data-wo-root] [data-wo-rename-panel],[data-wo-root] [data-wo-move-panel]{background:var(--vscode-editorWidget-background,rgba(148,163,184,.07))!important;border:1px solid var(--wo-line)!important;border-radius:10px!important;padding:11px!important;gap:9px!important;box-shadow:none!important}
[data-wo-root] [data-wo-create-panel] [data-wo-create-conversation],[data-wo-root] [data-wo-create-panel] [data-wo-link-workspace-start],[data-wo-root] [data-wo-create-panel] [data-wo-directory]{display:none!important}
[data-wo-root] input,[data-wo-root] select{width:100%;min-width:0;box-sizing:border-box;border-radius:7px!important;padding:7px 9px!important;background:var(--vscode-input-background,transparent)!important;border:1px solid var(--vscode-input-border,rgba(148,163,184,.35))!important;color:var(--vscode-foreground,inherit)!important}
[data-wo-root] [data-wo-notice]{border-radius:7px;padding:8px;background:rgba(211,115,79,.08);font-size:11px!important}
[data-wo-root] [data-wo-snapshot-stale]{border-radius:7px;padding:7px;background:rgba(216,164,53,.1);font-size:11px!important}
@media (prefers-reduced-motion:reduce){[data-wo-root] *,[data-wo-root] *::before,[data-wo-root] *::after{transition:none!important}}`;
		const rowStyle = { fontSize: "12px", lineHeight: "20px", borderRadius: "4px", display: "flex", alignItems: "center", flexWrap: "wrap", minWidth: "0", boxSizing: "border-box" };
		const rowButtonStyle = { fontSize: "11px", padding: "2px 6px", borderRadius: "4px", cursor: "pointer", flexShrink: 0 };
		const inputStyle = { fontSize: "12px", padding: "3px 6px", borderRadius: "4px", border: "1px solid rgba(128,128,128,0.4)", background: "transparent" };
		const sectionStyle = { display: "flex", flexDirection: "column", gap: "2px", borderRadius: "4px", background: "rgba(128,128,128,0.05)", padding: "4px" };
		const sectionHeaderStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "2px 4px", cursor: "pointer", userSelect: "none" };
		const sectionBodyStyle = { padding: "4px 8px", display: "flex", flexDirection: "column", gap: "2px" };

		/* ------------------------------------------------------------------ *
		 * Client services are read from the live context at call time.
		 * ------------------------------------------------------------------ */

		let clientContext;

		function useRemote() {
			const remote = clientContext === undefined ? undefined : clientContext.get("remote");
			if (remote === undefined || remote === null || remote[NAMESPACE] === undefined) {
				throw new Error("workspaceOrganizer Remote namespace is not mounted");
			}
			return remote[NAMESPACE];
		}

		function getUiWorkspace() {
			return clientContext === undefined ? undefined : clientContext.get("uiWorkspace");
		}

		async function apply(ctx) {
			clientContext = ctx;
			const disposeMount = await ctx.remote.$mount(contribution);
			let handle;
			let disposeSlot;
			try {
				handle = ctx.inject(["remote.workspaceOrganizer", "uiWorkspace"], (child) => {
					clientContext = child;
					disposeSlot = child.slots.inject("sidebar.workspaces", () => child.slots.register({
						name: "sidebar.workspaces",
						// Lowest priority renders; the native browser is registered at 0,
						// so withdrawing this entry restores it.
						priority: -100
					}, OrganizerBrowser));
				});
				await handle;
			} catch (error) {
				if (handle !== undefined) await handle.dispose();
				await disposeMount();
				throw error;
			}
			return async () => {
				if (disposeSlot !== undefined) await disposeSlot();
				await handle.dispose();
				await disposeMount();
			};
		}

		const inject = ["slots", "remote", "uiWorkspace"];

		exports.apply = apply;
		exports.inject = inject;
		exports.contribution = contribution;
		return module.exports;
	}
});
