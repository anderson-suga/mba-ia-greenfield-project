import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
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
  VideoUploadInitResponseDto,
} from './dto/video-response.dto';

/**
 * The upload endpoints are throttled above the global 10-req/min limit: a single
 * upload legitimately issues several requests (init, parts, complete), and the
 * global limit would reject the flow mid-transfer.
 */
const UPLOAD_THROTTLE = { default: { limit: 60, ttl: 60_000 } };

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
}
