from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from harmony_agent.domain import (
    Conversation,
    ConversationSummary,
    CreateConversationRequest,
    UpdateConversationRequest,
)
from harmony_agent.repositories import (
    ConversationNotFoundError,
    RepositoryGitError,
    RepositoryNotFoundError,
)
from harmony_repo_mcp import InspectionBoundaryError

from ..dependencies import ApplicationContainer
from ..services.conversations import create_conversation, public_conversation

_EXCLUDE_STATE = {"messages_state", "evidence_state"}

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
