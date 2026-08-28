from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from harmony_agent.domain import (
    CaseDraft,
    Conversation,
    ConversationSummary,
    CreateConversationRequest,
    LinkCaseRequest,
    UpdateConversationRequest,
)
from harmony_agent.repositories import (
    CaseNotFoundError,
    ConversationNotFoundError,
    RepositoryGitError,
    RepositoryNotFoundError,
)
from harmony_repo_mcp import InspectionBoundaryError

from ..chat_stream import chat_model_available
from ..dependencies import ApplicationContainer
from ..services.conversations import create_conversation, public_conversation

_EXCLUDE_STATE = {"messages_state"}

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


def container(request: Request) -> ApplicationContainer:
    return request.app.state.container


async def _get_conversation(conversation_id: str, request: Request) -> Conversation:
    try:
        return await container(request).conversations.get(conversation_id)
    except ConversationNotFoundError as exc:
        raise HTTPException(status_code=404, detail="conversation not found") from exc


@router.get("", response_model=list[ConversationSummary])
async def list_conversations(request: Request) -> list[ConversationSummary]:
    conversations = await container(request).conversations.list()
    return [ConversationSummary.from_conversation(item) for item in conversations]


@router.post(
    "",
    response_model=Conversation,
    response_model_exclude=_EXCLUDE_STATE,
    status_code=status.HTTP_201_CREATED,
)
async def create_new_conversation(
    payload: CreateConversationRequest,
    request: Request,
) -> dict:
    try:
        conversation = await create_conversation(payload, container(request))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RepositoryNotFoundError as exc:
        raise HTTPException(status_code=404, detail="repository not found") from exc
    except (RepositoryGitError, InspectionBoundaryError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return public_conversation(conversation)


@router.get(
    "/{conversation_id}",
    response_model=Conversation,
    response_model_exclude=_EXCLUDE_STATE,
)
async def get_conversation(conversation_id: str, request: Request) -> dict:
    conversation = await _get_conversation(conversation_id, request)
    return public_conversation(conversation)


@router.patch(
    "/{conversation_id}",
    response_model=Conversation,
    response_model_exclude=_EXCLUDE_STATE,
)
async def update_conversation(
    conversation_id: str,
    payload: UpdateConversationRequest,
    request: Request,
) -> dict:
    conversation = await _get_conversation(conversation_id, request)
    if payload.title:
        conversation.title = payload.title
    if payload.model_override is not None:
        conversation.model_override = payload.model_override or None
    saved = await container(request).conversations.save(conversation)
    return public_conversation(saved)


@router.delete("/{conversation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_conversation(conversation_id: str, request: Request) -> Response:
    conversation = await _get_conversation(conversation_id, request)
    await container(request).conversations.delete(conversation.id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{conversation_id}/promote-draft", response_model=CaseDraft)
async def promote_draft(conversation_id: str, request: Request) -> CaseDraft:
    app_container = container(request)
    if not chat_model_available(app_container):
        raise HTTPException(status_code=409, detail="提取案例草稿需要先在模型设置中配置模型")
    conversation = await _get_conversation(conversation_id, request)
    if not any(message.role == "assistant" for message in conversation.messages):
        raise HTTPException(status_code=422, detail="会话还没有对话内容，无法提取案例草稿")
    repositories = await app_container.repositories.list()
    return await app_container.promote_agent.extract(conversation, repositories)


@router.post(
    "/{conversation_id}/cases",
    response_model=Conversation,
    response_model_exclude=_EXCLUDE_STATE,
)
async def link_case(
    conversation_id: str,
    payload: LinkCaseRequest,
    request: Request,
) -> dict:
    app_container = container(request)
    conversation = await _get_conversation(conversation_id, request)
    try:
        await app_container.cases.get(payload.case_id)
    except CaseNotFoundError as exc:
        raise HTTPException(status_code=404, detail="diagnosis case not found") from exc
    if payload.case_id not in conversation.case_ids:
        conversation.case_ids.append(payload.case_id)
    for message in reversed(conversation.messages):
        if message.role == "assistant":
            message.case_id = payload.case_id
            break
    saved = await app_container.conversations.save(conversation)
    return public_conversation(saved)
