import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from './videos.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreatePartsDto } from './dto/create-parts.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import {
  VideoCompleteResponseDto,
  VideoPartsResponseDto,
  VideoPlaybackUrlResponseDto,
  VideoPublicResponseDto,
  VideoUploadInitResponseDto,
} from './dto/video-response.dto';

/**
 * The upload endpoints are throttled above the global 10-req/min limit: a single
 * upload legitimately issues several requests (init, parts, complete), and the
 * global limit would reject the flow mid-transfer.
 */
const UPLOAD_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

const PUBLIC_ID_PARAM = {
  name: 'public_id',
  description:
    'Public identifier of the video, as returned when it was created.',
} as const;

const VIDEO_ID_PARAM = {
  name: 'id',
  format: 'uuid',
  description: 'Internal video id returned when the upload was initiated.',
} as const;

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @Throttle(UPLOAD_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload. The response carries the upload id used to presign parts; no video bytes pass through the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    type: VideoUploadInitResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Declared size exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Media type not allowed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage unavailable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initUpload(
    @Body() dto: CreateVideoUploadDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<VideoUploadInitResponseDto> {
    return this.videosService.initUpload(dto, user.sub);
  }

  @Post(':id/parts')
  @HttpCode(HttpStatus.OK)
  @Throttle(UPLOAD_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Presign upload parts',
    description:
      'Returns a presigned URL per requested part number. The client PUTs each part straight to storage, so the bytes never transit the API.',
  })
  @ApiParam(VIDEO_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: VideoPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer in draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage unavailable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async createPartUrls(
    @Param('id') id: string,
    @Body() dto: CreatePartsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<VideoPartsResponseDto> {
    return this.videosService.createPartUrls(id, dto, user.sub);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle(UPLOAD_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Assembles the uploaded parts, verifies the real object size, then moves the video to processing and records the job in the same transaction.',
  })
  @ApiParam(VIDEO_ID_PARAM)
  @ApiResponse({
    status: 202,
    description: 'Upload accepted for processing',
    type: VideoCompleteResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft, including a repeated completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'Stored object exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Upload cannot be completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage unavailable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<VideoCompleteResponseDto> {
    return this.videosService.completeUpload(id, dto, user.sub);
  }

  @Post(':id/abort')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(UPLOAD_THROTTLE)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Discards the multipart upload and marks the draft as errored. The row is kept for audit.',
  })
  @ApiParam(VIDEO_ID_PARAM)
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer in draft',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    return this.videosService.abortUpload(id, user.sub);
  }

  @Public()
  @Get(':public_id')
  @ApiOperation({
    summary: 'Get public video metadata',
    description:
      'Returns the publicly visible fields for a video. The internal id and the storage key are never exposed.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Public video metadata',
    type: VideoPublicResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getMetadata(
    @Param('public_id') publicId: string,
  ): Promise<VideoPublicResponseDto> {
    return this.videosService.getPublicMetadata(publicId);
  }

  @Public()
  @Get(':public_id/stream')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects (302) to a presigned storage URL. The player follows it and issues range requests directly against storage, so playback starts without transferring the whole file and the API never carries video bytes.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned playback URL',
    headers: {
      Location: {
        description: 'Presigned storage URL',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage unavailable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('public_id') publicId: string,
    @Res() response: Response,
  ): Promise<void> {
    const url = await this.videosService.getStreamUrl(publicId);
    response.redirect(HttpStatus.FOUND, url);
  }

  @Get(':public_id/download')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Requires authentication — downloading is a user action, while watching is open to anonymous visitors. Redirects (302) to a presigned URL signed as an attachment.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned download URL',
    headers: {
      Location: {
        description: 'Presigned storage URL with an attachment disposition',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Object storage unavailable',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('public_id') publicId: string,
    @Res() response: Response,
  ): Promise<void> {
    const url = await this.videosService.getDownloadUrl(publicId);
    response.redirect(HttpStatus.FOUND, url);
  }

  @Public()
  @Get(':public_id/thumbnail')
  @ApiOperation({
    summary: 'Get a video thumbnail',
    description:
      'Redirects (302) to a presigned URL for the generated JPEG. Returns 404 while the video has no thumbnail yet.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 302,
    description: 'Redirect to the presigned thumbnail URL',
    headers: {
      Location: {
        description: 'Presigned storage URL',
        schema: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found, or no thumbnail yet',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(
    @Param('public_id') publicId: string,
    @Res() response: Response,
  ): Promise<void> {
    const url = await this.videosService.getThumbnailUrl(publicId);
    response.redirect(HttpStatus.FOUND, url);
  }

  @Public()
  @Get(':public_id/playback-url')
  @ApiOperation({
    summary: 'Refresh a playback URL',
    description:
      'Issues a fresh presigned playback URL, so a player can recover after its previous URL expires.',
  })
  @ApiParam(PUBLIC_ID_PARAM)
  @ApiResponse({
    status: 200,
    description: 'Fresh presigned playback URL',
    type: VideoPlaybackUrlResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async playbackUrl(
    @Param('public_id') publicId: string,
  ): Promise<VideoPlaybackUrlResponseDto> {
    return this.videosService.getPlaybackUrl(publicId);
  }
}
